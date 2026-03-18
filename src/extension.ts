import * as vscode from 'vscode';
import { PicoPandaDiagnostics } from './diagnostics';
import { PicoPandaBuilder } from './builder';
import { PicoPandaTestRunner } from './testRunner';

export function activate(context: vscode.ExtensionContext) {
    const diagnostics = new PicoPandaDiagnostics();
    const builder     = new PicoPandaBuilder(diagnostics);
    const testRunner  = new PicoPandaTestRunner(diagnostics);

    context.subscriptions.push(diagnostics, builder, testRunner);

    // ── helper: resolve workspace root ────────────────────────────────────────
    const root = (): string | undefined =>
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    const requireRoot = (): string | undefined => {
        const r = root();
        if (!r) { vscode.window.showErrorMessage('Pico Panda: no workspace open.'); }
        return r;
    };

    // ── commands ──────────────────────────────────────────────────────────────

    context.subscriptions.push(

        vscode.commands.registerCommand('picoPanda.compile', async () => {
            const r = requireRoot(); if (!r) { return; }
            await builder.run(['compile'], r);
        }),

        vscode.commands.registerCommand('picoPanda.run', async () => {
            const r = requireRoot(); if (!r) { return; }
            await builder.run(['run'], r);
        }),

    );
}

export function deactivate() {}
