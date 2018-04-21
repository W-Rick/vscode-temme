import EventEmitter from 'events'
import path from 'path'
import temme, { cheerio, temmeParser } from 'temme'
import { TAGGED_LINK_PATTERN, TEMME_MODE } from './constants'
import StatusBarController from './StatusBarController'
import TemmeCodeActionProvider from './TemmeCodeActionProvider'
import TemmeDocumentSymbolProvider from './TemmeDocumentSymbolProvider'
import {
  commands,
  Diagnostic,
  DiagnosticCollection,
  ExtensionContext,
  languages,
  OutputChannel,
  Position,
  Range,
  TextDocument,
  TextDocumentChangeEvent,
  Uri,
  window,
  workspace,
} from 'vscode'
import {
  downloadHtmlFromLink,
  isTemmeDocActive,
  openOutputDocument,
  placeViewColumnTwoIfNotVisible,
  pprint,
  replaceWholeDocument,
} from './utils'

type Status = 'ready' | 'running' | 'watching'

let log: OutputChannel
let emitter: EventEmitter
let diagnosticCollection: DiagnosticCollection
let status: Status
let changeCallback: any
let statusBarController: StatusBarController

/** 解析文档中的 temme 选择器，并报告选择器语法错误 */
function detectAndReportTemmeGrammarError(temmeDoc: TextDocument) {
  try {
    temmeParser.parse(temmeDoc.getText())
    diagnosticCollection.delete(temmeDoc.uri)
  } catch (e) {
    let start: Position
    let end: Position
    if (e.location != null && e.location.start != null && e.location.end != null) {
      start = new Position(e.location.start.line - 1, e.location.start.column - 1)
      const endLine = e.location.end.line - 1
      end = new Position(endLine, temmeDoc.lineAt(endLine).text.length)
    } else {
      // 如果错误位置无法确定的话，就使用第一行
      start = new Position(0, 0)
      end = new Position(0, temmeDoc.lineAt(0).text.length)
    }
    diagnosticCollection.set(temmeDoc.uri, [new Diagnostic(new Range(start, end), e.message)])
  }
}

/** 从temme文档中挑选链接。
 * 如果文档中没有链接，则什么也不做
 * 如果文档中有多个链接，则弹出快速选择框让用户进行选择
 * */
async function pickLink(temmeDoc: TextDocument) {
  const taggedLinks: { tag: string; link: string }[] = []

  const lineCount = temmeDoc.lineCount
  for (let lineIndex = 0; lineIndex < lineCount; lineIndex++) {
    const line = temmeDoc.lineAt(lineIndex)
    const match = line.text.match(TAGGED_LINK_PATTERN)
    if (match) {
      taggedLinks.push({
        tag: match[1],
        link: match[2].trim(),
      })
    }
  }

  if (taggedLinks.length === 0) {
    window.showInformationMessage('No link is found in current file.')
    return
  } else {
    const options = taggedLinks.map(({ tag, link }) => `${tag} ${link}`)
    const result = await window.showQuickPick(options, { placeHolder: 'Choose an url:' })
    if (result) {
      return taggedLinks[options.indexOf(result)].link
    }
  }
}

async function getLink(link?: string) {
  const editor = window.activeTextEditor
  if (editor == null) {
    window.showWarningMessage('No temme file opened.')
    return
  }
  const document = editor.document
  if (document.languageId !== 'temme') {
    window.showWarningMessage('Not a temme file.')
    return
  }
  if (link == null) {
    link = await pickLink(document)
  }
  return link
}

async function runSelector(link?: string) {
  link = await getLink(link)
  if (link == null) {
    return
  }
  const temmeDoc = window.activeTextEditor!.document

  try {
    status = 'running'
    statusBarController.setRunning()
    const html = await downloadHtmlFromLink(link)
    const result = temme(html, temmeDoc.getText())
    const outputDoc = await openOutputDocument(temmeDoc)
    await placeViewColumnTwoIfNotVisible(outputDoc)
    await window.showTextDocument(temmeDoc)
    await replaceWholeDocument(outputDoc, pprint(result))
    window.showInformationMessage('Success')
  } catch (e) {
    window.showErrorMessage(e.message)
  }

  status = 'ready'
  statusBarController.autoUpdate()
}

async function startWatch(link?: string) {
  stop()
  if (!isTemmeDocActive()) {
    return
  }

  const temmeDoc = window.activeTextEditor!.document
  link = await getLink(link)
  if (link == null) {
    return
  }

  status = 'watching'
  statusBarController.setWatching()

  try {
    const html = await downloadHtmlFromLink(link)
    const $ = cheerio.load(html, { decodeEntities: false })

    const outputFileName = path.resolve(temmeDoc.uri.fsPath, '../', `${temmeDoc.fileName}.json`)
    const outputDoc = await workspace.openTextDocument(Uri.file(outputFileName))
    await placeViewColumnTwoIfNotVisible(outputDoc)
    await window.showTextDocument(temmeDoc)

    async function onThisTemmeDocumentChange(changedLine: number) {
      try {
        const result = temme($, temmeDoc.getText())
        log.appendLine('outputDoc.isClosed: ' + outputDoc.isClosed)
        await replaceWholeDocument(outputDoc, pprint(result))
      } catch (e) {
        if (e.name !== 'SyntaxError') {
          // TODO 错误不一定在当前编辑的这一行 或第一行
          diagnosticCollection.set(temmeDoc.uri, [
            new Diagnostic(new Range(changedLine, 0, changedLine + 1, 0), e.message),
          ])
        }
        log.appendLine(e.message)
      }
    }

    changeCallback = async function({ document, contentChanges }: TextDocumentChangeEvent) {
      if (document === temmeDoc) {
        let line = 0
        if (contentChanges.length > 0) {
          line = contentChanges[0].range.start.line
        }
        await onThisTemmeDocumentChange(line)
      }
    }

    emitter.addListener('did-change-text-document', changeCallback)

    // 手动触发更新
    await onThisTemmeDocumentChange(0)
  } catch (e) {
    window.showErrorMessage(e.message)
    log.appendLine(e.stack || e.message)
  }
}

function stop() {
  log.appendLine(`[temme] in stop() & current-status: ${status}`)
  if (status === 'watching') {
    emitter.removeListener('did-change-text-document', changeCallback)
    changeCallback = null
    status = 'ready'
    statusBarController.autoUpdate()
  } else if (status === 'running') {
    log.appendLine('cancelling a running task is not supported')
  } else {
    log.appendLine('status is ready. nothing to stop')
  }
}

export function activate(ctx: ExtensionContext) {
  status = 'ready'
  log = window.createOutputChannel('temme')

  emitter = new EventEmitter()
  diagnosticCollection = languages.createDiagnosticCollection('temme')
  statusBarController = new StatusBarController()

  ctx.subscriptions.push(
    commands.registerCommand('temme.runSelector', runSelector),
    commands.registerCommand('temme.startWatch', startWatch),
    commands.registerCommand('temme.stop', stop),
    languages.registerDocumentSymbolProvider(TEMME_MODE, new TemmeDocumentSymbolProvider()),
    languages.registerCodeActionsProvider(TEMME_MODE, new TemmeCodeActionProvider()),
    workspace.onDidChangeTextDocument(event => {
      if (event.document.languageId === 'temme') {
        detectAndReportTemmeGrammarError(event.document)
        emitter.emit('did-change-text-document', event)
      }
    }),
    window.onDidChangeActiveTextEditor(() => {
      if (status === 'ready') {
        statusBarController.autoUpdate()
      }
    }),
    diagnosticCollection,
    statusBarController,
    {
      dispose() {
        stop()
      },
    },
  )

  if (isTemmeDocActive()) {
    statusBarController.setReady()
    detectAndReportTemmeGrammarError(window.activeTextEditor!.document)
  }
}
