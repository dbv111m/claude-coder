import { ClaudeAsk, ClaudeMessage, isV1ClaudeMessage } from "../../../shared/ExtensionMessage"
import { ClaudeAskResponse } from "../../../shared/WebviewMessage"
import { KODU_ERROR_CODES, KoduError, koduSSEResponse } from "../../../shared/kodu"
import { StateManager } from "../state-manager"
import { ToolExecutor } from "../tools/tool-executor"
import { ChunkProcessor } from "../chunk-proccess"
import { ExtensionProvider } from "../../../providers/claude-coder/ClaudeCoderProvider"
import { ApiHistoryItem, ToolResponse, UserContent } from "../types"
import { AskDetails, AskResponse, TaskError, TaskState, TaskExecutorUtils } from "./utils"
import { formatImagesIntoBlocks, isTextBlock } from "../utils"
import { getErrorMessage } from "../types/errors"
import { AskManager } from "./ask-manager"
import { ChatTool } from "../../../shared/new-tools"

// Constants for buffer management
const BUFFER_FLUSH_INTERVAL = 10 // ms
const BUFFER_SIZE_THRESHOLD = 50 // characters

export class TaskExecutor extends TaskExecutorUtils {
	public state: TaskState = TaskState.IDLE
	private toolExecutor: ToolExecutor
	private currentUserContent: UserContent | null = null
	private isRequestCancelled: boolean = false
	private abortController: AbortController | null = null
	private consecutiveErrorCount: number = 0
	private isAborting: boolean = false
	private streamPaused: boolean = false
	private textBuffer: string = ""
	private askManager: AskManager
	private flushTimeout: NodeJS.Timeout | null = null
	private lastFlushTime: number = 0
	private currentReplyId: number | null = null

	constructor(stateManager: StateManager, toolExecutor: ToolExecutor, providerRef: WeakRef<ExtensionProvider>) {
		super(stateManager, providerRef)
		this.toolExecutor = toolExecutor
		this.askManager = new AskManager(stateManager)
	}

	protected getState(): TaskState {
		return this.state
	}

	public async ask(type: ClaudeAsk, data?: AskDetails): Promise<AskResponse> {
		return this.askManager.ask(type, data)
	}

	public async askWithId(type: ClaudeAsk, data?: AskDetails, askTs?: number): Promise<AskResponse> {
		return this.askManager.ask(type, data, askTs)
	}

	public handleAskResponse(response: ClaudeAskResponse, text?: string, images?: string[]): void {
		const lastAskMessage = [...this.stateManager.state.claudeMessages].reverse().find((msg) => msg.type === "ask")
		if (lastAskMessage) {
			this.askManager.handleResponse(lastAskMessage.ts, response, text, images)
		}
	}

	public pauseStream() {
		if (!this.streamPaused) {
			this.streamPaused = true
			// Ensure any buffered content is flushed before pausing
			if (this.currentReplyId !== null) {
				this.flushTextBuffer(this.currentReplyId, true)
			}
		}
	}

	public resumeStream() {
		if (this.streamPaused) {
			this.streamPaused = false
			this.lastFlushTime = Date.now() // Reset flush timer on resume
		}
	}

	private async flushTextBuffer(currentReplyId?: number | null, force: boolean = false) {
		if (!this.textBuffer.trim() || !currentReplyId) {
			return
		}

		const now = Date.now()
		const timeSinceLastFlush = now - this.lastFlushTime

		// Clear any existing timeout
		if (this.flushTimeout) {
			clearTimeout(this.flushTimeout)
			this.flushTimeout = null
		}

		// If forced, buffer is large enough, or enough time has passed, flush immediately
		if (force || this.textBuffer.length >= BUFFER_SIZE_THRESHOLD || timeSinceLastFlush >= BUFFER_FLUSH_INTERVAL) {
			const contentToFlush = this.textBuffer
			this.textBuffer = "" // Clear buffer before async operations
			await this.stateManager.appendToClaudeMessage(currentReplyId, contentToFlush)
			await this.stateManager.providerRef.deref()?.getWebviewManager()?.postStateToWebview()
			this.lastFlushTime = now
		} else if (!this.streamPaused) {
			// Only schedule new flush if stream is not paused
			this.flushTimeout = setTimeout(async () => {
				if (this.textBuffer.trim() && !this.streamPaused) {
					const contentToFlush = this.textBuffer
					this.textBuffer = ""
					await this.stateManager.appendToClaudeMessage(currentReplyId, contentToFlush)
					await this.stateManager.providerRef.deref()?.getWebviewManager()?.postStateToWebview()
					this.lastFlushTime = Date.now()
				}
			}, BUFFER_FLUSH_INTERVAL - timeSinceLastFlush)
		}
	}

	public async newMessage(message: UserContent) {
		if (this.isAborting) {
			throw new Error("Cannot start new message while aborting")
		}
		this.logState("New message")
		this.state = TaskState.WAITING_FOR_API
		this.isRequestCancelled = false
		this.abortController = new AbortController()
		this.currentUserContent = message
		await this.say("user_feedback", message[0].type === "text" ? message[0].text : "New message")
		await this.makeClaudeRequest()
	}

	public async startTask(userContent: UserContent): Promise<void> {
		if (this.isAborting) {
			throw new Error("Cannot start task while aborting")
		}
		this.logState("Starting task")
		this.state = TaskState.WAITING_FOR_API
		this.currentUserContent = this.normalizeUserContent(userContent)
		this.isRequestCancelled = false
		this.abortController = new AbortController()
		this.consecutiveErrorCount = 0
		await this.makeClaudeRequest()
	}

	public async resumeTask(userContent: UserContent): Promise<void> {
		if (this.isAborting) {
			throw new Error("Cannot resume task while aborting")
		}
		if (this.state === TaskState.WAITING_FOR_USER) {
			this.logState("Resuming task")
			this.state = TaskState.WAITING_FOR_API
			this.currentUserContent = this.normalizeUserContent(userContent)
			this.isRequestCancelled = false
			this.consecutiveErrorCount = 0
			this.abortController = new AbortController()
			await this.makeClaudeRequest()
		} else {
			this.logError(new Error("Cannot resume task: not in WAITING_FOR_USER state") as TaskError)
		}
	}

	private normalizeUserContent(content: UserContent): UserContent {
		if (content.length === 0 || (content[0]?.type === "text" && !content[0].text?.trim())) {
			return [{ type: "text", text: "Let's continue with the task, from where we left off." }]
		}
		return content
	}

	public async abortTask(): Promise<void> {
		if (this.isAborting) {
			return
		}

		this.isAborting = true
		try {
			this.logState("Aborting task")
			const now = Date.now()

			// Cancel the current request
			await this.cancelCurrentRequest()

			// Cleanup tool executor
			await this.toolExecutor.abortTask()

			// Reset state
			await this.resetState()

			this.logState(`Task aborted in ${Date.now() - now}ms`)
		} finally {
			this.isAborting = false
		}
	}

	private async cancelCurrentRequest(): Promise<void> {
		if (this.isRequestCancelled) {
			return // Prevent multiple cancellations
		}

		// Check if this is the first message
		if (this.stateManager.state.claudeMessages.length === 2) {
			return // Can't cancel the first message
		}

		this.logState("Cancelling current request")
		this.isRequestCancelled = true
		this.abortController?.abort()
		this.state = TaskState.ABORTED

		// Find the last api request and tool request
		const lastApiRequest = this.stateManager.state.claudeMessages
			.slice()
			.reverse()
			.find((msg) => msg.type === "say" && msg.say === "api_req_started")

		const lastToolRequest = this.stateManager.state.claudeMessages
			.slice()
			.reverse()
			.find((msg) => {
				if (!isV1ClaudeMessage(msg) || msg.ask !== "tool") {
					return false
				}
				const parsedTool = JSON.parse(msg.text ?? "{}") as ChatTool
				return parsedTool.approvalState !== "error"
			})

		// Update tool request if exists and not already approved
		if (lastToolRequest) {
			const parsedTool = JSON.parse(lastToolRequest.text ?? "{}") as ChatTool
			if (parsedTool.approvalState !== "approved") {
				await this.updateAsk(
					lastToolRequest.ask!,
					{
						tool: {
							...parsedTool,
							approvalState: "error",
							error: "Task was interrupted before this tool call could be completed.",
						},
					},
					lastToolRequest.ts
				)
			}
		}

		// Update API request if exists and not done
		if (lastApiRequest && isV1ClaudeMessage(lastApiRequest) && !lastApiRequest.isDone) {
			await this.stateManager.updateClaudeMessage(lastApiRequest.ts, {
				...lastApiRequest,
				isDone: true,
				isFetching: false,
				errorText: "Request cancelled by user",
				isError: true,
			})
		}

		this.ask("resume_task", {
			question:
				"Task was interrupted before the last response could be generated. Would you like to resume the task?",
		}).then((res) => {
			if (res.response === "yesButtonTapped") {
				this.state = TaskState.WAITING_FOR_API
				this.currentUserContent = [
					{ type: "text", text: "Let's continue with the task, from where we left off." },
				]
				this.makeClaudeRequest()
			} else if ((res.response === "noButtonTapped" && res.text) || res.images) {
				const newContent: UserContent = []
				if (res.text) {
					newContent.push({ type: "text", text: res.text })
				}
				if (res.images) {
					const formattedImages = formatImagesIntoBlocks(res.images)
					newContent.push(...formattedImages)
				}
				this.currentUserContent = newContent
				this.state = TaskState.WAITING_FOR_API
				this.makeClaudeRequest()
			} else {
				this.state = TaskState.COMPLETED
			}
		})

		// Update the provider state
		await this.stateManager.providerRef.deref()?.getWebviewManager()?.postStateToWebview()
	}

	public async makeClaudeRequest(): Promise<void> {
		try {
			if (
				this.state !== TaskState.WAITING_FOR_API ||
				!this.currentUserContent ||
				this.isRequestCancelled ||
				this.isAborting
			) {
				return
			}

			// Reset states
			await this.toolExecutor.resetToolState()
			this.isRequestCancelled = false
			this.abortController = new AbortController()
			this.streamPaused = false
			this.textBuffer = ""
			this.lastFlushTime = Date.now()
			this.currentReplyId = null

			if (this.consecutiveErrorCount >= 3) {
				await this.ask("resume_task", {
					question: "Claude has encountered an error 3 times in a row. Would you like to resume the task?",
				})
			}

			this.logState("Making Claude API request")

			// Add user content to history and start request
			await this.stateManager.addToApiConversationHistory({
				role: "user",
				content: this.currentUserContent,
			})

			const startedReqId = await this.say(
				"api_req_started",
				JSON.stringify({
					request: this.stateManager.apiManager.createUserReadableRequest(this.currentUserContent),
				})
			)

			const stream = this.stateManager.apiManager.createApiStreamRequest(
				this.stateManager.state.apiConversationHistory,
				this.abortController?.signal
			)

			if (this.isRequestCancelled || this.isAborting) {
				this.abortController?.abort()
				this.logState("Request cancelled, ignoring response")
				return
			}

			this.state = TaskState.PROCESSING_RESPONSE
			await this.processApiResponse(stream, startedReqId)
		} catch (error) {
			if (!this.isRequestCancelled && !this.isAborting) {
				if (error instanceof KoduError) {
					console.log("[TaskExecutor] KoduError:", error)
					if (error.errorCode === KODU_ERROR_CODES.AUTHENTICATION_ERROR) {
						await this.handleApiError(new TaskError({ type: "UNAUTHORIZED", message: error.message }))
						return
					}
					if (error.errorCode === KODU_ERROR_CODES.PAYMENT_REQUIRED) {
						await this.handleApiError(new TaskError({ type: "PAYMENT_REQUIRED", message: error.message }))
						return
					}
					await this.handleApiError(new TaskError({ type: "API_ERROR", message: error.message }))
					return
				}
				// @ts-expect-error
				await this.handleApiError(new TaskError({ type: "UNKNOWN_ERROR", message: error.message }))
			} else {
				console.log("[TaskExecutor] Request was cancelled, ignoring error")
			}
		}
	}

	private async processApiResponse(
		stream: AsyncGenerator<koduSSEResponse, any, unknown>,
		startedReqId: number
	): Promise<void> {
		if (this.state !== TaskState.PROCESSING_RESPONSE || this.isRequestCancelled || this.isAborting) {
			return
		}

		try {
			this.logState("Processing API response")
			const currentReplyId = await this.say("text", "", undefined, Date.now(), { isSubMessage: true })
			this.currentReplyId = currentReplyId

			const apiHistoryItem: ApiHistoryItem = {
				role: "assistant",
				ts: startedReqId,
				content: [
					{
						type: "text",
						text: "the response was interrupted in the middle of processing",
					},
				],
			}
			await this.stateManager.addToApiConversationHistory(apiHistoryItem)

			let accumulatedText = ""

			const processor = new ChunkProcessor({
				onImmediateEndOfStream: async (chunk) => {
					if (this.isRequestCancelled || this.isAborting) {
						return
					}

					if (chunk.code === 1) {
						const { inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens } =
							chunk.body.internal
						await this.stateManager.updateClaudeMessage(startedReqId, {
							...this.stateManager.getMessageById(startedReqId)!,
							apiMetrics: {
								cost: chunk.body.internal.cost,
								inputTokens,
								outputTokens,
								inputCacheRead: cacheReadInputTokens,
								inputCacheWrite: cacheCreationInputTokens,
							},
							isDone: true,
							isFetching: false,
						})
						await this.stateManager.providerRef.deref()?.getWebviewManager()?.postStateToWebview()
					}

					if (chunk.code === -1) {
						await this.stateManager.updateClaudeMessage(startedReqId, {
							...this.stateManager.getMessageById(startedReqId)!,
							isDone: true,
							isFetching: false,
							errorText: chunk.body.msg ?? "Internal Server Error",
							isError: true,
						})
						await this.stateManager.providerRef.deref()?.getWebviewManager()?.postStateToWebview()
						throw new KoduError({ code: chunk.body.status ?? 500 })
					}
				},

				onChunk: async (chunk) => {
					if (this.isRequestCancelled || this.isAborting) {
						return
					}

					if (chunk.code === 2) {
						// Update API history first
						if (Array.isArray(apiHistoryItem.content) && isTextBlock(apiHistoryItem.content[0])) {
							apiHistoryItem.content[0].text =
								apiHistoryItem.content[0].text ===
								"the response was interrupted in the middle of processing"
									? chunk.body.text
									: apiHistoryItem.content[0].text + chunk.body.text
							await this.stateManager.updateApiHistoryItem(startedReqId, apiHistoryItem)
						}

						// Process chunk only if stream is not paused
						if (!this.streamPaused) {
							// Accumulate text until we have a complete XML tag or enough non-XML content
							accumulatedText += chunk.body.text

							// Process for tool use and get non-XML text
							const nonXMLText = await this.toolExecutor.processToolUse(accumulatedText)
							accumulatedText = "" // Clear accumulated text after processing

							// If we got non-XML text, add it to buffer
							if (nonXMLText) {
								this.textBuffer += nonXMLText
								// Only flush buffer if we're not paused
								await this.flushTextBuffer(this.currentReplyId)
							}

							// If tool processing started, pause the stream
							if (this.toolExecutor.hasActiveTools()) {
								// Ensure any buffered content is flushed before pausing
								await this.flushTextBuffer(this.currentReplyId, true)
								this.pauseStream()
								// Wait for tool processing to complete
								await this.toolExecutor.waitForToolProcessing()
								// Resume stream after tool processing
								this.resumeStream()
								const newReplyId = await this.say("text", "", undefined, Date.now(), {
									isSubMessage: true,
								})
								this.currentReplyId = newReplyId
							}
						}
					}
				},

				onFinalEndOfStream: async () => {
					if (this.isRequestCancelled || this.isAborting) {
						return
					}

					// Process any remaining accumulated text
					if (accumulatedText) {
						const nonXMLText = await this.toolExecutor.processToolUse(accumulatedText)
						if (nonXMLText) {
							this.textBuffer += nonXMLText
						}
					}

					// Ensure all tools are processed
					await this.toolExecutor.waitForToolProcessing()

					// Flush any remaining text
					if (this.flushTimeout) {
						clearTimeout(this.flushTimeout)
						this.flushTimeout = null
					}
					await this.flushTextBuffer(currentReplyId, true)
					this.currentReplyId = null

					await this.finishProcessingResponse(apiHistoryItem)
				},
			})

			await processor.processStream(stream)
		} catch (error) {
			if (this.isRequestCancelled || this.isAborting) {
				throw error
			}
			throw error
		}
	}

	private async resetState() {
		if (this.flushTimeout) {
			clearTimeout(this.flushTimeout)
			this.flushTimeout = null
		}
		this.abortController?.abort()
		this.isRequestCancelled = false
		this.abortController = null
		this.consecutiveErrorCount = 0
		this.state = TaskState.WAITING_FOR_USER
		this.streamPaused = false
		this.textBuffer = ""
		this.lastFlushTime = Date.now()
		this.currentReplyId = null
		await this.stateManager.providerRef.deref()?.getWebviewManager()?.postStateToWebview()
	}

	private async finishProcessingResponse(assistantResponses: ApiHistoryItem): Promise<void> {
		this.logState("Finishing response processing")
		if (this.isRequestCancelled || this.isAborting) {
			return
		}

		// Ensure no empty content in API history
		if (
			!assistantResponses.content.length ||
			(isTextBlock(assistantResponses.content[0]) && !assistantResponses.content[0].text.trim())
		) {
			if (assistantResponses.ts) {
				await this.stateManager.updateApiHistoryItem(assistantResponses.ts, {
					role: "assistant",
					content: [{ type: "text", text: "Failed to generate a response, please try again." }],
				})
			}
		}

		const currentToolResults = await this.toolExecutor.getToolResults()

		if (currentToolResults.length > 0) {
			const completionAttempted = currentToolResults.find((result) => result?.name === "attempt_completion")

			if (completionAttempted) {
				await this.stateManager.addToApiConversationHistory({
					role: "user",
					content: completionAttempted.result,
				})
				await this.stateManager.addToApiConversationHistory({
					role: "assistant",
					content: [{ type: "text", text: "Task completed successfully." }],
				})
				this.state = TaskState.COMPLETED
			} else {
				this.state = TaskState.WAITING_FOR_API
				this.currentUserContent = currentToolResults.flatMap((result) => {
					if (typeof result.result === "string") {
						return [{ type: "text", text: result.result }]
					}
					return result.result
				})
				await this.makeClaudeRequest()
			}
		} else {
			this.state = TaskState.WAITING_FOR_API
			this.currentUserContent = [
				{
					type: "text",
					text: "You must use a tool to proceed. Either use attempt_completion if you've completed the task, or ask_followup_question if you need more information.",
				},
			]
			await this.makeClaudeRequest()
		}
	}

	private async handleApiError(error: TaskError): Promise<void> {
		this.logError(error)
		console.log(`[TaskExecutor] Error (State: ${this.state}):`, error)
		await this.toolExecutor.resetToolState()

		const lastAssistantMessage = this.stateManager.state.apiConversationHistory.at(-1)
		if (lastAssistantMessage?.role === "assistant" && lastAssistantMessage.ts) {
			if (typeof lastAssistantMessage.content === "string") {
				lastAssistantMessage.content = [{ type: "text", text: lastAssistantMessage.content }]
			}
			if (Array.isArray(lastAssistantMessage.content) && isTextBlock(lastAssistantMessage.content[0])) {
				lastAssistantMessage.content[0].text =
					lastAssistantMessage.content[0].text.trim() ||
					"An error occurred in the generation of the response. Please try again."
			}
			await this.stateManager.updateApiHistoryItem(lastAssistantMessage.ts, lastAssistantMessage)
		}

		this.consecutiveErrorCount++
		if (error.type === "PAYMENT_REQUIRED" || error.type === "UNAUTHORIZED") {
			this.state = TaskState.IDLE
			await this.say(error.type === "PAYMENT_REQUIRED" ? "payment_required" : "unauthorized", error.message)
			return
		}

		const { response } = await this.ask("api_req_failed", { question: error.message })
		if (response === "yesButtonTapped" || response === "messageResponse") {
			await this.say("api_req_retried")
			this.state = TaskState.WAITING_FOR_API
			await this.makeClaudeRequest()
		} else {
			this.state = TaskState.COMPLETED
		}
	}
}
