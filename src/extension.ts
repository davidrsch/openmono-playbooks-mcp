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
        return server;
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
