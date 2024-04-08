import { readFileSync } from "fs";
import vscode from "vscode";
import { Tools } from "../api/Tools";
import { getLocalCertPath, getRemoteCertificateDirectory, localClientCertExists, readRemoteCertificate, remoteServerCertificateExists } from "../api/debug/certificates";
import { DebugJob, getDebugServerJob, getDebugServiceDetails, getDebugServiceJob, isDebugEngineRunning, readActiveJob, readJVMInfo, startServer, startService, stopServer, stopService } from "../api/debug/server";
import { instance } from "../instantiate";
import { t } from "../locale";
import { BrowserItem } from "../typings";

const title = "IBM i debugger";
type Certificates = {
  secureDebug: boolean
  remoteCertificate?: string,
  localCertificate?: string
}

type CertificateIssue = {
  label: string
  detail?: string
  context: string
}

export function initializeDebugBrowser(context: vscode.ExtensionContext) {
  const debugBrowser = new DebugBrowser();
  const debugTreeViewer = vscode.window.createTreeView(
    `ibmiDebugBrowser`, {
    treeDataProvider: debugBrowser,
    showCollapseAll: true
  });

  const updateDebugBrowser = async () => {
    if (instance.getConnection()) {
      debugTreeViewer.title = `${title} ${(await getDebugServiceDetails()).version}`
      debugTreeViewer.description = await isDebugEngineRunning() ? t("online") : t("offline");
    }
    else {
      debugTreeViewer.title = title;
      debugTreeViewer.description = "";
    }

    debugBrowser.refresh();
  }

  instance.onEvent("connected", updateDebugBrowser);
  instance.onEvent("disconnected", updateDebugBrowser);

  context.subscriptions.push(
    debugTreeViewer,
    vscode.commands.registerCommand("code-for-ibmi.debug.refresh", updateDebugBrowser),
    vscode.commands.registerCommand("code-for-ibmi.debug.refresh.item", (item: DebugItem) => debugBrowser.refresh(item)),
    vscode.commands.registerCommand("code-for-ibmi.debug.job.start", (item: DebugJobItem) => item.start()),
    vscode.commands.registerCommand("code-for-ibmi.debug.job.stop", (item: DebugJobItem) => item.stop()),
    vscode.commands.registerCommand("code-for-ibmi.debug.job.restart", async (item: DebugJobItem) => await item.start() && item.stop()),
  );
}

class DebugBrowser implements vscode.TreeDataProvider<BrowserItem> {
  private readonly _emitter: vscode.EventEmitter<DebugItem | undefined | null | void> = new vscode.EventEmitter();
  readonly onDidChangeTreeData: vscode.Event<DebugItem | undefined | null | void> = this._emitter.event;

  refresh(item?: DebugItem) {
    this._emitter.fire(item);
  }

  getTreeItem(element: DebugItem) {
    return element;
  }

  async getChildren(item?: DebugItem) {
    return item?.getChildren?.() || this.getRootItems();
  }

  private async getRootItems() {
    const connection = instance.getConnection();
    if (connection) {
      const certificates: Certificates = {
        secureDebug: connection.config?.debugIsSecure || false
      };

      if (await remoteServerCertificateExists(connection)) {
        certificates.remoteCertificate = await readRemoteCertificate(connection);
        if (certificates.secureDebug && await localClientCertExists(connection)) {
          certificates.localCertificate = readFileSync(getLocalCertPath(connection)).toString("utf-8");
        }
      }

      return [
        new DebugJobItem("server",
          t("debug.server"),
          startServer,
          stopServer,
          await getDebugServerJob()
        ),
        new DebugJobItem("service",
          t("debug.service"),
          () => startService(connection),
          () => stopService(connection),
          await getDebugServiceJob(),
          certificates
        )
      ];
    }
    else {
      return [];
    }
  }

  async resolveTreeItem(item: vscode.TreeItem, element: BrowserItem, token: vscode.CancellationToken) {
    const content = instance.getContent();
    if (content && element.tooltip === undefined && element instanceof DebugJobItem && element.debugJob) {
      element.tooltip = new vscode.MarkdownString(`${t(`listening.on.port${element.debugJob.ports.length === 1 ? '' : 's'}`)} ${element.debugJob.ports.join(", ")}\n\n`);
      const activeJob = await readActiveJob(content, element.debugJob);
      if (activeJob) {
        const jobToMarkDown = (job: Tools.DB2Row | string) => typeof job === "string" ? job : Object.entries(job).filter(([key, value]) => value !== null).map(([key, value]) => `- ${t(key)}: ${value}`).join("\n");
        element.tooltip.appendMarkdown(jobToMarkDown(activeJob));
        if (element.type === "service") {
          element.tooltip.appendMarkdown("\n\n");
          const jvmJob = await readJVMInfo(content, element.debugJob);
          if (jvmJob) {
            element.tooltip.appendMarkdown(jobToMarkDown(jvmJob));
          }
        }
      }

      return element;
    }
  }
}

class DebugItem extends BrowserItem {
  refresh() {
    vscode.commands.executeCommand("code-for-ibmi.debug.refresh.item", this);
  }
}

class DebugJobItem extends DebugItem {
  private problem: undefined | CertificateIssue;

  constructor(readonly type: "server" | "service", label: string, readonly startFunction: () => Promise<boolean>, readonly stopFunction: () => Promise<boolean>, readonly debugJob?: DebugJob, certificates?: Certificates) {
    let problem: undefined | CertificateIssue
    const cantRun = certificates && !certificates.remoteCertificate;
    const running = !cantRun && debugJob !== undefined;
    if (certificates) {
      if (!certificates.remoteCertificate) {
        problem = {
          context: "noremote",
          label: t('remote.certificate.not.found'),
          detail: t('remote.certificate.not.found.detail', "debug_service.pfx", getRemoteCertificateDirectory(instance.getConnection()!))
        }
      }
      else if (certificates.secureDebug) {
        if (!certificates.localCertificate) {
          problem = {
            context: "nolocal",
            label: t('local.certificate.not.found')
          };
        }
        else if (certificates.remoteCertificate !== certificates.localCertificate) {
          problem = {
            context: "dontmatch",
            label: t('local.dont.match.remote')
          };
        }
      }
    }

    super(label, {
      state: problem ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
      icon: problem ? "warning" : (running ? "pass" : "error"),
      color: problem ? cantRun ? "testing.iconFailed" : "testing.iconQueued" : (running ? "testing.iconPassed" : "testing.iconFailed")
    });
    this.contextValue = `debugJob_${type}${cantRun ? '' : `_${running ? "on" : "off"}`}`;
    this.problem = problem;

    if (running) {
      this.description = debugJob.name;
    }
    else {
      this.description = t("offline");
      this.tooltip = "";
    }
  }

  getChildren() {
    if (this.problem) {
      return [new CertificateIssueItem(this.problem)];
    }
  }

  async start() {
    return vscode.window.withProgress({ title: t(`start.debug.${this.type}.task`), location: vscode.ProgressLocation.Window }, this.startFunction);
  }

  async stop() {
    return vscode.window.withProgress({ title: t(`stop.debug.${this.type}.task`), location: vscode.ProgressLocation.Window }, this.stopFunction);
  }
}

class CertificateIssueItem extends DebugItem {
  constructor(issue: CertificateIssue) {
    super(issue.label)
    this.description = issue.detail;
    this.tooltip = issue.detail || '';
    this.contextValue = `certificateIssue_${issue.context}`;
  }
}