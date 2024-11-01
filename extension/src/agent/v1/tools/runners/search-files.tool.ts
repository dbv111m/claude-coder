import * as path from "path"
import { serializeError } from "serialize-error"
import { ClaudeSayTool } from "../../../../shared/ExtensionMessage"
import { ToolResponse } from "../../types"
import { formatGenericToolFeedback, formatToolResponse, getReadablePath } from "../../utils"
import { regexSearchFiles } from "../../../../utils/ripgrep"
import { AgentToolOptions, AgentToolParams } from "../types"
import { BaseAgentTool } from "../base-agent.tool"

export class SearchFilesTool extends BaseAgentTool {
	protected params: AgentToolParams

	constructor(params: AgentToolParams, options: AgentToolOptions) {
		super(options)
		this.params = params
	}

	async execute(): Promise<ToolResponse> {
		const { input, ask, say } = this.params
		const { path: relDirPath, regex, filePattern } = input

		if (relDirPath === undefined) {
			await say(
				"error",
				"Claude tried to use search_files without value for required parameter 'path'. Retrying..."
			)

			return `Error: Missing value for required parameter 'path'. Please retry with complete response.
			An example of a good tool call is:
			{
				"tool": "search_files",
				"path": "path/to/directory",
				"regex": "pattern",
			}
			Please try again with the correct regex and path, you are not allowed to search files without a regex or path.
			`
		}

		if (regex === undefined) {
			await say(
				"error",
				"Claude tried to use search_files without value for required parameter 'regex'. Retrying..."
			)

			return `Error: Missing value for required parameter 'regex'. Please retry with complete response.
			{
				"tool": "search_files",
				"regex": "pattern",
				"path": "path/to/directory",
			}
			Please try again with the correct regex and path, you are not allowed to search files without a regex or path.
			`
		}

		try {
			const absolutePath = path.resolve(this.cwd, relDirPath)
			const results = await regexSearchFiles(this.cwd, absolutePath, regex, filePattern)

			const { response, text, images } = await ask!(
				"tool",
				{
					tool: {
						tool: "search_files",
						path: getReadablePath(relDirPath, this.cwd),
						regex: regex,
						filePattern: filePattern,
						approvalState: "pending",
						content: results,
						ts: this.ts,
					},
				},
				this.ts
			)

			if (response !== "yesButtonTapped") {
				this.params.updateAsk(
					"tool",
					{
						tool: {
							tool: "search_files",
							path: getReadablePath(relDirPath, this.cwd),
							regex: regex,
							filePattern: filePattern,
							approvalState: "rejected",
							content: results,
							ts: this.ts,
						},
					},
					this.ts
				)
				if (response === "messageResponse") {
					// await say("user_feedback", text, images)
					await this.params.updateAsk(
						"tool",
						{
							tool: {
								tool: "search_files",
								userFeedback: text,
								approvalState: "rejected",
								ts: this.ts,
								path: getReadablePath(relDirPath, this.cwd),
								regex: regex,
								filePattern: filePattern,
							},
						},
						this.ts
					)
					return formatToolResponse(formatGenericToolFeedback(text), images)
				}

				return "The user denied this operation."
			}

			this.params.updateAsk(
				"tool",
				{
					tool: {
						tool: "search_files",
						path: getReadablePath(relDirPath, this.cwd),
						regex: regex,
						filePattern: filePattern,
						approvalState: "approved",
						content: results,
						ts: this.ts,
					},
				},
				this.ts
			)

			return results
		} catch (error) {
			const errorString = `Error searching files: ${JSON.stringify(serializeError(error))}
			An example of a good searchFiles tool call is:
			{
				"tool": "search_files",
				"path": "path/to/directory",
				"regex": "pattern",
			}
			Please try again with the correct regex and path, you are not allowed to search files without a regex or path.
			`
			await say(
				"error",
				`Error searching files:\n${(error as Error).message ?? JSON.stringify(serializeError(error), null, 2)}`
			)

			return errorString
		}
	}
}
