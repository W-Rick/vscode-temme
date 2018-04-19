import fs from 'fs'
import path from 'path'
import temme, { temmeParser } from 'temme'
import fetch from 'node-fetch'
import debounce from 'lodash.debounce'
import {
  CancellationToken,
  CodeActionContext,
  CodeActionProvider,
  Command,
  commands,
  Diagnostic,
  DiagnosticCollection,
  DocumentFilter,
  DocumentSymbolProvider,
  ExtensionContext,
  languages,
  Position,
  Range,
  SymbolInformation,
  TextDocument,
  Uri,
  ViewColumn,
  window,
  workspace,
} from 'vscode'

const TEMME_MODE: DocumentFilter = { language: 'temme', scheme: 'file' }

const linkPattern = /((?:https?:\/\/)|(?:file:\/\/\/))([-a-zA-Z0-9@:%_+.~#?&/=]+)\b/gi

// let log: OutputChannel
let diagnosticCollection: DiagnosticCollection

class TemmeDocumentSymbolProvider implements DocumentSymbolProvider {
  public async provideDocumentSymbols(
    document: TextDocument,
    token: CancellationToken,
  ): Promise<SymbolInformation[]> {
    // TODO xx
    return []
  }
}

function onChangeTemmeSelector() {
  const editor = window.activeTextEditor
  if (editor == null) {
    return
  }
  const document = editor.document
  if (document.languageId !== 'temme') {
    return
  }
  try {
    temmeParser.parse(document.getText())
    diagnosticCollection.clear()
  } catch (e) {
    let start: Position
    let end: Position
    if (e.location.start != null && e.location.end != null) {
      start = new Position(e.location.start.line - 1, e.location.start.column - 1)
      const endLine = e.location.end.line - 1
      end = new Position(endLine, document.lineAt(endLine).text.length)
    } else {
      // 如果错误位置无法确定的话，就使用第一行
      // TODO 放在非空白的第一行效果更好一些
      start = new Position(0, 0)
      end = new Position(0, document.lineAt(0).text.length)
    }
    diagnosticCollection.set(document.uri, [new Diagnostic(new Range(start, end), e.message)])
  }
}

const debouncedOnChangeTemmeSelector = debounce(onChangeTemmeSelector, 300)

async function pickLink(document: TextDocument) {
  const text = document.getText()
  const links: string[] = []

  linkPattern.lastIndex = 0
  while (true) {
    const match = linkPattern.exec(text)
    if (match == null) {
      break
    }
    links.push(match[0])
  }
  linkPattern.lastIndex = 0

  if (links.length === 0) {
    window.showInformationMessage('No link is found in current file.')
    return
  } else if (links.length === 1) {
    return links[0]
  } else {
    return await window.showQuickPick(links, { placeHolder: 'Choose an url:' })
  }
}

async function downloadHtmlFromUrl(url: string) {
  let isFileLink = false
  if (url.startsWith('file:///')) {
    url = url.replace('file:///', '')
    isFileLink = true
  }

  if (isFileLink) {
    return fs.readFileSync(url, 'utf8')
  } else {
    const response = await fetch(url)
    if (response.ok) {
      return await response.text()
    } else {
      throw new Error(`Cannot download html from ${url}`)
    }
  }
}

async function runSelector(url?: string) {
  const editor = window.activeTextEditor
  if (editor == null) {
    window.showWarningMessage('No file opened.')
    return
  }
  const document = editor.document
  if (document.languageId !== 'temme') {
    window.showWarningMessage('Not a temme file.')
    return
  }
  if (url == null) {
    url = await pickLink(document)
  }
  if (url == null) {
    return
  }

  try {
    const html = await downloadHtmlFromUrl(url)
    const result = temme(html, document.getText())
    const outputContent = JSON.stringify(result, null, 2)
    const outputFileName = path.resolve(document.uri.fsPath, '../', `${document.fileName}.json`)
    fs.writeFileSync(outputFileName, outputContent, 'utf8')

    const outputDocument = await workspace.openTextDocument(Uri.file(outputFileName))
    const visibleDocs = new Set(window.visibleTextEditors.map(editor => editor.document))
    if (!visibleDocs.has(outputDocument)) {
      await window.showTextDocument(outputDocument, ViewColumn.Two)
    }
    await window.showInformationMessage('Success')
  } catch (e) {
    window.showErrorMessage(e.stack || e.message)
  }
}

class TemmeCodeActionProvider implements CodeActionProvider {
  async provideCodeActions(
    document: TextDocument,
    range: Range,
    context: CodeActionContext,
    token: CancellationToken,
  ) {
    const editor = window.activeTextEditor
    if (editor == null) {
      return null
    }
    const currentLineText = document.lineAt(editor.selection.start.line).text
    const match = currentLineText.match(linkPattern)
    if (match != null) {
      const url = match[0]
      return [
        {
          title: `Run selector against ${url}`,
          command: 'temme.runSelector',
          arguments: [url],
        } as Command,
      ]
    } else {
      return null
    }
  }
}

export function activate(ctx: ExtensionContext) {
  diagnosticCollection = languages.createDiagnosticCollection('temme')

  ctx.subscriptions.push(
    commands.registerCommand('temme.runSelector', runSelector),
    languages.registerDocumentSymbolProvider(TEMME_MODE, new TemmeDocumentSymbolProvider()),
    languages.registerCodeActionsProvider(TEMME_MODE, new TemmeCodeActionProvider()),
    workspace.onDidChangeTextDocument(debouncedOnChangeTemmeSelector),
    diagnosticCollection,
  )

  onChangeTemmeSelector()
}
