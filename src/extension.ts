/**
 * VS Code Extension Entry Point
 *
 * Registers playbooks-mcp as an MCP server definition provider so that
 * it appears automatically in Settings → Copilot → MCP Servers → Installed
 * when the extension is installed from the Marketplace.
 *
 * The actual MCP stdio server lives in src/index.ts — this file is just
 * the VS Code glue that tells the editor "here's an MCP server to manage."
 */

import * as vscode from "vscode";
import * as path from "path";

/**
 * Called by VS Code when the extension is activated (onStartupFinished).
 * Registers the MCP server definition provider.
 */
export function activate(context: vscode.ExtensionContext): void {
  // Resolve the path to the compiled MCP stdio server
  const serverPath = context.asAbsolutePath("dist/index.js");

  context.subscriptions.push(
    vscode.lm.registerMcpServerDefinitionProvider("playbooks-mcp", {
      /**
       * Called eagerly by VS Code to discover available MCP servers.
       * No user interaction should be performed here.
       */
      provideMcpServerDefinitions: async (
        _token: vscode.CancellationToken,
      ): Promise<vscode.McpServerDefinition[]> => {
        // Read configured search paths from VS Code settings
        const config = vscode.workspace.getConfiguration("playbooks");
        const searchPath = config.get<string>("searchPath") ?? "~/.openmono/playbooks";

        return [
          new vscode.McpStdioServerDefinition(
            "Playbooks MCP",
            "node",
            [serverPath],
            { PLAYBOOKS_PATH: searchPath },
            context.extension.packageJSON.version,
          ),
        ];
      },

      /**
       * Called when VS Code needs to start the server.
       * Use this to resolve any auth tokens or prompt the user.
       * Return undefined to prevent the server from starting.
       */
      resolveMcpServerDefinition: async (
        server: vscode.McpServerDefinition,
        _token: vscode.CancellationToken,
      ): Promise<vscode.McpServerDefinition | undefined> => {
        // Gather workspace-root playbooks paths to append to PLAYBOOKS_PATH.
        // This is critical: when the MCP stdio server starts, its process.cwd()
        // is NOT the user's project root, so the loader's CWD-based discovery
        // (process.cwd()/.openmono/playbooks) never finds project-local playbooks.
        const config = vscode.workspace.getConfiguration("playbooks");
        const searchPath = config.get<string>("searchPath") ?? "~/.openmono/playbooks";
        const paths: string[] = [searchPath];
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders) {
          for (const folder of workspaceFolders) {
            paths.push(`${folder.uri.fsPath}/.openmono/playbooks`);
          }
        }

        // Preserve the original command and args from the initial definition
        const stdioDef = server as vscode.McpStdioServerDefinition;

        const env: Record<string, string> = {
          PLAYBOOKS_PATH: paths.join(path.delimiter),
          WORKSPACE_ROOTS: workspaceFolders ? workspaceFolders.map(f => f.uri.fsPath).join(path.delimiter) : "",
        };

        return new vscode.McpStdioServerDefinition(
          server.label,
          stdioDef.command,
          stdioDef.args ?? [],
          env,
          context.extension.packageJSON.version,
        );
      },
    }),
  );

  console.log("[playbooks-mcp] Extension activated");
}

/**
 * Called by VS Code when the extension is deactivated.
 */
export function deactivate(): void {
  // No cleanup needed — VS Code handles MCP server lifecycle
}
