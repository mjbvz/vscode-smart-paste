// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { DocumentPasteEdit } from 'vscode';

interface CopyMetadata {
	readonly sourceLanguage: string;
}

const pasteKind = vscode.DocumentDropOrPasteEditKind.Empty.append('smart');


class SmartPasteEdit extends vscode.DocumentPasteEdit {

	constructor(
		public readonly text: string,
		public readonly document: vscode.TextDocument,
		public readonly ranges: readonly vscode.Range[],
		public readonly metadata: CopyMetadata | undefined,
		public readonly model: vscode.LanguageModelChat,
	) {
		super('', '✨ Smart paste', pasteKind);
	}
}

class AiPasteProvider implements vscode.DocumentPasteEditProvider<SmartPasteEdit> {
	public static readonly metadataMime = 'application/x-vscode-smart-paste-metadata';

	async prepareDocumentPaste(document: vscode.TextDocument, ranges: readonly vscode.Range[], dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
		const metadata: CopyMetadata = {
			sourceLanguage: document.languageId,
		};
		dataTransfer.set(AiPasteProvider.metadataMime, new vscode.DataTransferItem(JSON.stringify(metadata)));
	}

	async provideDocumentPasteEdits(document: vscode.TextDocument, ranges: readonly vscode.Range[], dataTransfer: vscode.DataTransfer, context: vscode.DocumentPasteEditContext, token: vscode.CancellationToken): Promise<SmartPasteEdit[] | undefined> {
		const text = await dataTransfer.get('text/plain')?.asString();
		if (!text || token.isCancellationRequested) {
			return;
		}

		let metadata: CopyMetadata | undefined;
		try {
			const metadataItem = dataTransfer.get(AiPasteProvider.metadataMime);
			if (metadataItem) {
				metadata = JSON.parse(await metadataItem.asString()) as CopyMetadata;
			}
		} catch {
			// Ignore
		}
		if (token.isCancellationRequested) {
			return;
		}

		const models = await vscode.lm.selectChatModels({ family: 'gpt-4' });
		if (token.isCancellationRequested || !models.length) {
			return;
		}
		const model = models[0];
		const edit = new SmartPasteEdit(text, document, ranges, metadata, model);
		edit.yieldTo = [vscode.DocumentDropOrPasteEditKind.Empty.append('text')];
		return [edit];
	}

	async resolveDocumentPasteEdit(edit: SmartPasteEdit, token: vscode.CancellationToken): Promise<SmartPasteEdit | undefined> {
		const metadata = edit.metadata;

		const messages = [
			vscode.LanguageModelChatMessage.Assistant(joinLines(
				`You are an AI coding assistant that helps translate code.`,
				`The user will supply you with code to be translated so it can be used in a new location.`,
				`The user may also provide you with a code context excerpt showing the new location where the translated code will be used.`,
				`You job is to translate the user's code ${metadata ? 'from ' + metadata.sourceLanguage + `into ${edit.document.languageId}` : ''} so it can be used in this new context.`,
				`If a code context excerpt is provided, use it to guide your translation. Your translation should follow the naming conventions, formatting style, documentation usage, and other coding conventions of the provided code context.`,
				`Make sure your translation is syntactically correct.`,
				`Reply with only the translated code in a markdown fenced code block.`,
				`DO NOT explain.`,
				`DO NOT include any extra text before or after the fenced code block.`,
			)),
		];
		const context = this.getPasteContext(edit.document, edit.ranges);
		if (context) {
			messages.push(vscode.LanguageModelChatMessage.User(joinLines(
				`Here's an code excerpt showing where the translated code will be used. My code will be inserted at \`<<CURSOR>>\`:`,
				``,
				'```' + edit.document.languageId,
				context,
				'```',
			)));
		}

		messages.push(vscode.LanguageModelChatMessage.User(joinLines(
			`Please translate the following code:`,
			``,
			'```' + (metadata?.sourceLanguage || ''),
			edit.text,
			'```',
		)));

		const request = await edit.model.sendRequest(messages, {}, token);
		if (token.isCancellationRequested) {
			return;
		}

		const parts: string[] = [];
		try {
			for await (const message of request.text) {
				parts.push(message);
				if (token.isCancellationRequested) {
					return;
				}
			}
		} catch (e) {
			return;
		}

		const response = parts.join('').trim();
		const lines = response.split(/\r\n|\r|\n/);
		const newCode = lines.slice(1, -1).join('\n');

		const workspaceEdit = new vscode.WorkspaceEdit();
		workspaceEdit.set(edit.document.uri, edit.ranges.map(x => new vscode.SnippetTextEdit(x, new vscode.SnippetString().appendText(newCode).appendTabstop())));
		edit.additionalEdit = workspaceEdit;

		return edit;
	}

	private getPasteContext(document: vscode.TextDocument, ranges: readonly vscode.Range[]): string | undefined {
		const maxLen = 1000; // TODO: base this on copied code length
		const pre = document.getText(new vscode.Range(0, 0, ranges[0].start.line, ranges[0].start.character)).slice(-maxLen);
		const post = document.getText(new vscode.Range(ranges[0].end.line, ranges[0].end.character, Number.MAX_SAFE_INTEGER, 0)).slice(maxLen);
		if (pre.length || post.length) {
			return pre + '<<CURSOR>>' + post;
		}
		return undefined;
	}
}

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(vscode.languages.registerDocumentPasteEditProvider('*', new AiPasteProvider(), {
		providedPasteEditKinds: [pasteKind],
		copyMimeTypes: [AiPasteProvider.metadataMime],
		pasteMimeTypes: ['text/plain', AiPasteProvider.metadataMime],
	}));

	context.subscriptions.push(vscode.commands.registerCommand('smartPaste.paste', async () => {
		return vscode.commands.executeCommand('editor.action.pasteAs', {
			kind: pasteKind.value,
		});
	}));
}

function joinLines(...lines: string[]): string {
	return lines.join('\n');
}