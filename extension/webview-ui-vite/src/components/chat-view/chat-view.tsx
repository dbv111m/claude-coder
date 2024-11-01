import React, { useCallback, useEffect, useMemo, useState, useTransition } from "react"
import { ChatState, ChatViewProps } from "./chat"
import { useAtom } from "jotai"
import { attachmentsAtom, syntaxHighlighterAtom } from "./atoms"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useChatMessageHandling } from "@/hooks/use-message-handler"
import { useImageHandling } from "@/hooks/use-image-handler"
import { useMessageRunning } from "@/hooks/use-message-running"
import { combineApiRequests } from "../../../../src/shared/combineApiRequests"
import { combineCommandSequences, COMMAND_STDIN_STRING } from "../../../../src/shared/combineCommandSequences"
import { getApiMetrics } from "../../../../src/shared/getApiMetrics"
import { getSyntaxHighlighterStyleFromTheme } from "@/utils/getSyntaxHighlighterStyleFromTheme"
import { vscode } from "@/utils/vscode"
import { ChatInput } from "./chat-input"
import ButtonSection from "../ChatView/ButtonSection"
import ChatScreen from "../ChatView/chat-screen"
import HistoryPreview from "../HistoryPreview/HistoryPreview"
import KoduPromo from "../KoduPromo/KoduPromo"
import Announcement from "../Announcement/Announcement"
import ChatMessages from "../ChatView/ChatMessages"
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism"
import { useOutOfCreditDialog } from "../dialogs/out-of-credit-dialog"
import TaskHeader from "../TaskHeader/TaskHeader"

const ChatView: React.FC<ChatViewProps> = ({
	isHidden,
	showAnnouncement,
	selectedModelSupportsImages,
	selectedModelSupportsPromptCache,
	hideAnnouncement,
	showHistoryView,
}) => {
	const { openOutOfCreditDialog, shouldOpenOutOfCreditDialog } = useOutOfCreditDialog()
	const [state, setState] = useState<ChatState>({
		inputValue: "",
		textAreaDisabled: false,
		selectedImages: [],
		thumbnailsHeight: 0,
		claudeAsk: undefined,
		enableButtons: false,
		primaryButtonText: undefined,
		secondaryButtonText: undefined,
		expandedRows: {},
		isAbortingRequest: false,
	})

	const updateState = useCallback((updates: Partial<ChatState>) => {
		setState((prev) => ({ ...prev, ...updates }))
	}, [])

	const [attachments, setAttachments] = useAtom(attachmentsAtom)
	const [syntaxHighlighterStyle, setSyntaxHighlighterStyle] = useAtom(syntaxHighlighterAtom)

	const {
		version,
		claudeMessages: messages,
		themeName: vscodeThemeName,
		uriScheme,
		shouldShowKoduPromo,
		user,
	} = useExtensionState()

	const [isPending, startTransition] = useTransition()

	const handleClaudeAskResponse = useCallback(
		(text: string) => {
			// if (!state.claudeAsk) return // Early return if no ask

			vscode.postMessage({
				type: "askResponse",
				askResponse: "messageResponse",
				text,
				images: state.selectedImages,
			})
		},
		[state]
	)

	// Batch button state updates in a transition
	const updateButtonState = useCallback((updates: Partial<ChatState>) => {
		startTransition(() => {
			setState((prev) => {
				// Only update if values changed
				const shouldUpdate =
					prev.enableButtons !== updates.enableButtons ||
					prev.primaryButtonText !== updates.primaryButtonText ||
					prev.secondaryButtonText !== updates.secondaryButtonText ||
					prev.claudeAsk !== updates.claudeAsk

				if (!shouldUpdate) return prev
				return { ...prev, ...updates }
			})
		})
	}, [])

	// Message handling with deferred updates
	const handleButtonStateUpdate = useCallback(
		(updates: Partial<ChatState>) => {
			startTransition(() => {
				if (
					"enableButtons" in updates ||
					"primaryButtonText" in updates ||
					"secondaryButtonText" in updates ||
					"claudeAsk" in updates
				) {
					updateButtonState(updates)
				} else {
					setState((prev) => ({ ...prev, ...updates }))
				}
			})
		},
		[updateButtonState]
	)
	useChatMessageHandling(messages, handleButtonStateUpdate, setAttachments)

	const { shouldDisableImages, handlePaste } = useImageHandling(selectedModelSupportsImages, state, updateState)

	const isMessageRunning = useMessageRunning(messages)

	const task = useMemo(() => (messages.length > 0 ? messages[0] : undefined), [messages])

	useEffect(() => {
		console.log("Task changed", task)
		if (!task) {
			// reset state when task is cleared
			updateState({
				inputValue: "",
				textAreaDisabled: false,
				selectedImages: [],
				claudeAsk: undefined,
				enableButtons: false,
			})
		}
	}, [task])

	const modifiedMessages = useMemo(() => combineApiRequests(combineCommandSequences(messages.slice(1))), [messages])

	const apiMetrics = useMemo(() => getApiMetrics(modifiedMessages), [modifiedMessages])

	const visibleMessages = useMemo(() => {
		return modifiedMessages.filter((message) => {
			if (
				(message.ask === "completion_result" && message.text === "") ||
				["resume_task", "resume_completed_task"].includes(message.ask!)
			) {
				return false
			}
			if (["api_req_finished", "api_req_retried"].includes(message.say!)) {
				return false
			}
			if (message.say === "api_req_started") return true
			if (message.say === "text" && (message.text ?? "") === "" && (message.images?.length ?? 0) === 0) {
				return false
			}
			return true
		})
	}, [modifiedMessages])

	useEffect(() => {
		setSyntaxHighlighterStyle(vscDarkPlus)
		if (!vscodeThemeName) return
		const theme = getSyntaxHighlighterStyleFromTheme(vscodeThemeName)
		if (theme) {
			setSyntaxHighlighterStyle(theme)
		}
	}, [vscodeThemeName, setSyntaxHighlighterStyle])

	const handleSendMessage = useCallback(
		(input?: string) => {
			if (shouldOpenOutOfCreditDialog) {
				openOutOfCreditDialog()
				return
			}

			let text = state.inputValue?.trim()
			if (!!input && input.length > 1) {
				text = input?.trim()
			}

			if (text || state.selectedImages.length > 0) {
				if (messages.length === 0) {
					vscode.postMessage({
						type: "newTask",
						text,
						images: state.selectedImages,
						attachements: attachments,
					})
				} else if (state.claudeAsk) {
					handleClaudeAskResponse(text)
				} else {
					vscode.postMessage({
						type: "askResponse",
						askResponse: "messageResponse",
						text,
						images: state.selectedImages,
						attachements: attachments,
					})
				}

				updateState({
					inputValue: "",
					textAreaDisabled: true,
					selectedImages: [],
					claudeAsk: undefined,
					enableButtons: false,
				})
				setAttachments([])
			}
		},
		[
			shouldOpenOutOfCreditDialog,
			state.inputValue,
			state.selectedImages,
			state.claudeAsk,
			openOutOfCreditDialog,
			messages.length,
			updateState,
			setAttachments,
			attachments,
			handleClaudeAskResponse,
		]
	)

	const handlePrimaryButtonClick = useCallback(() => {
		switch (state.claudeAsk) {
			case "api_req_failed":
			case "request_limit_reached":
			case "command":
			case "command_output":
			case "tool":
			case "resume_task":
				console.log("Primary button tapped")
				vscode.postMessage({ type: "askResponse", askResponse: "yesButtonTapped", text: undefined })
				if (state.claudeAsk === "tool") {
					return
				}
				if (shouldOpenOutOfCreditDialog) {
					openOutOfCreditDialog()
					return
				}
				break
			case "completion_result":
			case "resume_completed_task":
				vscode.postMessage({ type: "clearTask" })
				break
		}
		updateState({
			textAreaDisabled: true,
			claudeAsk: undefined,
			primaryButtonText: undefined,
			secondaryButtonText: undefined,
			enableButtons: false,
		})
	}, [state.claudeAsk, shouldOpenOutOfCreditDialog, openOutOfCreditDialog, updateState])

	const handleSecondaryButtonClick = useCallback(() => {
		switch (state.claudeAsk) {
			case "request_limit_reached":
			case "api_req_failed":
				vscode.postMessage({ type: "clearTask" })
				break
			case "command":
			case "tool":
				vscode.postMessage({ type: "askResponse", askResponse: "noButtonTapped" })
				break
		}
		updateState({
			textAreaDisabled: true,
			claudeAsk: undefined,
			primaryButtonText: undefined,
			secondaryButtonText: undefined,
			enableButtons: false,
		})
	}, [state.claudeAsk, updateState])

	const handleSendStdin = useCallback(
		(text: string) => {
			if (state.claudeAsk === "command_output") {
				vscode.postMessage({
					type: "askResponse",
					askResponse: "messageResponse",
					text: COMMAND_STDIN_STRING + text,
				})
				updateState({ claudeAsk: undefined })
			}
		},
		[state.claudeAsk, updateState]
	)

	return (
		<div
			className={`chat-container ${isHidden ? "hidden" : ""}`}
			style={{
				position: "fixed",
				top: 0,
				left: 0,
				right: 0,
				bottom: 0,
				display: isHidden ? "none" : "flex",
				flexDirection: "column",
				overflow: "hidden",
			}}>
			<div
				className="chat-content"
				style={{
					borderTop: "1px solid var(--section-border)",
					flex: "1 1 0%",
					display: "flex",
					flexDirection: "column",
					overflowY: "auto",
				}}>
				{task ? (
					<>
						<TaskHeader
							task={task}
							tokensIn={apiMetrics.totalTokensIn}
							tokensOut={apiMetrics.totalTokensOut}
							doesModelSupportPromptCache={selectedModelSupportsPromptCache}
							cacheWrites={apiMetrics.totalCacheWrites}
							cacheReads={apiMetrics.totalCacheReads}
							totalCost={apiMetrics.totalCost}
							onClose={() => vscode.postMessage({ type: "clearTask" })}
							isHidden={isHidden}
							koduCredits={user?.credits ?? 0}
							vscodeUriScheme={uriScheme}
						/>
						<ChatMessages
							taskId={task.ts}
							visibleMessages={visibleMessages}
							syntaxHighlighterStyle={syntaxHighlighterStyle}
							handleSendStdin={handleSendStdin}
						/>
					</>
				) : (
					<>
						{showAnnouncement && (
							<Announcement
								version={version}
								hideAnnouncement={hideAnnouncement}
								vscodeUriScheme={uriScheme}
							/>
						)}
						{!showAnnouncement && shouldShowKoduPromo && (
							<KoduPromo style={{ margin: "10px 15px -10px 15px" }} />
						)}
						<ChatScreen
							taskHistory={<HistoryPreview showHistoryView={showHistoryView} />}
							handleClick={handleSendMessage}
						/>
					</>
				)}

				<ButtonSection
					primaryButtonText={state.primaryButtonText}
					secondaryButtonText={state.secondaryButtonText}
					enableButtons={state.enableButtons}
					isRequestRunning={isMessageRunning}
					handlePrimaryButtonClick={handlePrimaryButtonClick}
					handleSecondaryButtonClick={handleSecondaryButtonClick}
				/>

				<div className="mt-2 border-t">
					<ChatInput
						state={state}
						updateState={updateState}
						onSendMessage={handleSendMessage}
						shouldDisableImages={shouldDisableImages}
						handlePaste={handlePaste}
						isRequestRunning={isMessageRunning}
						isInTask={!!task}
						isHidden={isHidden}
					/>
				</div>
			</div>
		</div>
	)
}

export default React.memo(ChatView, (prevProps, nextProps) => {
	return (
		prevProps.isHidden === nextProps.isHidden &&
		prevProps.showAnnouncement === nextProps.showAnnouncement &&
		prevProps.selectedModelSupportsImages === nextProps.selectedModelSupportsImages &&
		prevProps.selectedModelSupportsPromptCache === nextProps.selectedModelSupportsPromptCache
	)
})
