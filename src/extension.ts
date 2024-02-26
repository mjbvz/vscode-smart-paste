// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { DocumentPasteEdit } from 'vscode';

interface CopyMetadata {
	readonly sourceLanguage: string;
}

class AiPasteProvider implements vscode.DocumentPasteEditProvider {
	public static readonly metadataMime = 'application/x-vscode-aipaste-metadata';

	async prepareDocumentPaste(document: vscode.TextDocument, ranges: readonly vscode.Range[], dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
		const metadata: CopyMetadata = {
			sourceLanguage: document.languageId,
		};
		dataTransfer.set(AiPasteProvider.metadataMime, new vscode.DataTransferItem(JSON.stringify(metadata)));
	}

	async provideDocumentPasteEdits(document: vscode.TextDocument, ranges: readonly vscode.Range[], dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<DocumentPasteEdit | undefined> {
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

		const access = await vscode.lm.requestLanguageModelAccess('copilot-gpt-4', {
			justification: 'Translation of pasted code.'
		});
		if (token.isCancellationRequested) {
			return;
		}
	
		const messages = [
			new vscode.LanguageModelSystemMessage(joinLines(
				`You are an AI coding assistant that helps translate code.`,
				`The user will supply you with code to be translated so it can be used in a new location.`,
				`The user may also provide you with a code context excerpt showing the new location where the translated code will be used.`,
				`You job is to translate the user's code ${metadata ? 'from ' + metadata.sourceLanguage  + `into ${document.languageId}` : ''} so it can be used in this new context.`,
				`If a code context excerpt is provided, use it to guide your translation. Your translation should follow the naming conventions, formatting style, documentation usage, and other coding conventions of the provided code context.`,
				`Make sure your translation is syntactically correct.`,
				`Reply with only the translated code in a markdown fenced code block.`,
				`DO NOT explain.`,
				`DO NOT include any extra text before or after the fenced code block.`,
			)),
		];
		const context = this.getPasteContext(document, ranges);
		if (context) {
			messages.push(new vscode.LanguageModelUserMessage(joinLines(
				`Here's an code excerpt showing where the translated code will be used. My code will be inserted at \`<<CURSOR>>\`:`,
				``,
				'```' + document.languageId,
				context,
				'```',
			)));
		}

		messages.push(new vscode.LanguageModelUserMessage(joinLines(
			`Here is the code that I need translated:`,
			``,
			'```' + (metadata?.sourceLanguage || ''),
			text,
			'```',
		)));

		const request = access.makeChatRequest(messages, {}, token);
		const parts: string[] = [];
		try {
			for await (const message of request.stream) {
				parts.push(message);
				if (token.isCancellationRequested) {
					return;
				}
			}
		} catch (e) {
			return undefined;
		}

		const response = parts.join('').trim();
		const lines = response.split(/\r\n|\r|\n/);
		const newCode = lines.slice(1, -1).join('\n');
		return new vscode.DocumentPasteEdit(newCode, '✨ Smart paste');
	}

	private getPasteContext(document: vscode.TextDocument, ranges: readonly vscode.Range[]): string | undefined {
		const maxLen = 1000; // TODO: base this on copied code length
		const pre = document.getText(new vscode.Range(0, 0, ranges[0].start.line, ranges[0].start.character)).slice(-maxLen);
		const post = document.getText(new vscode.Range(ranges[0].end.line, ranges[0].end.character, Number.MAX_SAFE_INTEGER, 0)).slice(maxLen);
		if (pre.length || post.length) {
			return 	pre + '<<CURSOR>>' + post;
		}
		return undefined;
	}
}

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(vscode.languages.registerDocumentPasteEditProvider('*', new AiPasteProvider(), {
		id: 'ai-paste',
		copyMimeTypes: [AiPasteProvider.metadataMime],
		pasteMimeTypes: ['text/plain', AiPasteProvider.metadataMime],
	}));
}

function joinLines(...lines: string[]): string {
	return lines.join('\n');
}