import * as vscode from 'vscode';

/** Parses ppd compiler errors into VS Code diagnostics (red squiggles). */
export class PicoPandaDiagnostics implements vscode.Disposable {
    private readonly collection =
        vscode.languages.createDiagnosticCollection('pico-panda');

    /** Parse [output] for `file:line:col: error: message` lines and update squiggles. */
    update(output: string) {
        this.collection.clear();

        const map = new Map<string, vscode.Diagnostic[]>();
        const re = /^(.+):(\d+):(\d+): error: (.+)$/gm;
        let m: RegExpExecArray | null;

        while ((m = re.exec(output)) !== null) {
            const [, file, lineStr, colStr, message] = m;
            const line = Math.max(0, parseInt(lineStr) - 1);
            const col  = Math.max(0, parseInt(colStr)  - 1);
            const range = new vscode.Range(line, col, line, col);
            const diag = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
            diag.source = 'ppd';
            if (!map.has(file)) { map.set(file, []); }
            map.get(file)!.push(diag);
        }

        for (const [file, diags] of map) {
            this.collection.set(vscode.Uri.file(file), diags);
        }
    }

    clear() {
        this.collection.clear();
    }

    dispose() {
        this.collection.dispose();
    }
}
