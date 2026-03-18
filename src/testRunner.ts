import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { PicoPandaDiagnostics } from './diagnostics';

interface TestFn {
    name: string;
    line: number; // 0-based line number of the `fun` keyword
}

export class PicoPandaTestRunner implements vscode.Disposable {
    private readonly controller: vscode.TestController;
    private readonly watcher: vscode.FileSystemWatcher;

    constructor(private readonly diagnostics: PicoPandaDiagnostics) {
        this.controller = vscode.tests.createTestController(
            'picoPandaTests',
            'Pico Panda'
        );

        this.controller.createRunProfile(
            'Run',
            vscode.TestRunProfileKind.Run,
            (req, tok) => this.runHandler(req, tok),
            /* isDefault */ true
        );

        // Watch for test file changes.
        this.watcher = vscode.workspace.createFileSystemWatcher('**/*_test.ppd');
        this.watcher.onDidCreate(uri => this.refreshFile(uri));
        this.watcher.onDidChange(uri => this.refreshFile(uri));
        this.watcher.onDidDelete(uri => this.controller.items.delete(uri.toString()));

        // Discover existing test files on activation.
        vscode.workspace.findFiles('**/*_test.ppd').then(uris => {
            for (const uri of uris) {
                this.refreshFile(uri);
            }
        });
    }

    // ── file loading ─────────────────────────────────────────────────────────

    private refreshFile(uri: vscode.Uri) {
        let text: string;
        try {
            text = fs.readFileSync(uri.fsPath, 'utf8');
        } catch {
            this.controller.items.delete(uri.toString());
            return;
        }

        const label = path.basename(uri.fsPath, '.ppd');
        const fileItem = this.controller.createTestItem(uri.toString(), label, uri);

        for (const fn of this.parseTests(text)) {
            const id = `${uri.toString()}::${fn.name}`;
            const fnItem = this.controller.createTestItem(id, fn.name, uri);
            fnItem.range = new vscode.Range(fn.line, 0, fn.line, 0);
            fileItem.children.add(fnItem);
        }

        this.controller.items.add(fileItem);
    }

    /** Finds all `@test fun <name>()` declarations in source text. */
    private parseTests(text: string): TestFn[] {
        const lines = text.split('\n');
        const fns: TestFn[] = [];

        for (let i = 0; i < lines.length - 1; i++) {
            if (lines[i].trimEnd() === '@test') {
                // The next non-blank line should be `fun <name>(...)`.
                for (let j = i + 1; j < lines.length; j++) {
                    const m = lines[j].match(/^\s*fun\s+(\w+)/);
                    if (m) {
                        fns.push({ name: m[1], line: j });
                        break;
                    }
                    if (lines[j].trim() !== '') {
                        break; // Not a fun declaration — give up.
                    }
                }
            }
        }

        return fns;
    }

    // ── run handler ──────────────────────────────────────────────────────────

    private async runHandler(
        req: vscode.TestRunRequest,
        token: vscode.CancellationToken
    ) {
        const run = this.controller.createTestRun(req);

        // Group requested test items by source file path.
        const fileMap = new Map<string, vscode.TestItem[]>();

        const enqueue = (item: vscode.TestItem) => {
            if (!item.uri) { return; }
            const key = item.uri.fsPath;

            if (item.children.size > 0) {
                // File-level item: run all its children.
                item.children.forEach(child => {
                    if (!fileMap.has(key)) { fileMap.set(key, []); }
                    fileMap.get(key)!.push(child);
                    run.started(child);
                });
            } else {
                // Function-level item.
                if (!fileMap.has(key)) { fileMap.set(key, []); }
                fileMap.get(key)!.push(item);
                run.started(item);
            }
        };

        if (req.include) {
            req.include.forEach(enqueue);
        } else {
            this.controller.items.forEach(enqueue);
        }

        for (const [filePath, items] of fileMap) {
            if (token.isCancellationRequested) { break; }
            await this.runFile(filePath, items, run, token);
        }

        run.end();
    }

    // ── per-file execution ───────────────────────────────────────────────────

    private runFile(
        filePath: string,
        items: vscode.TestItem[],
        run: vscode.TestRun,
        token: vscode.CancellationToken
    ): Promise<void> {
        // Walk up from the test file to find the nearest ppd.cfg (project root).
        const projectRoot = findProjectRoot(path.dirname(filePath))
            ?? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath))?.uri.fsPath
            ?? path.dirname(filePath);

        const ppdExe = vscode.workspace
            .getConfiguration('picoPanda')
            .get<string>('ppdPath', 'ppd');

        return new Promise(resolve => {
            let stdout = '';
            let stderr = '';

            let proc: ReturnType<typeof spawn>;
            try {
                proc = spawn(ppdExe, ['test', filePath], { cwd: projectRoot });
            } catch (err) {
                const msg = new vscode.TestMessage(
                    `Failed to launch ppd: ${err}. ` +
                    `Check the 'picoPanda.ppdPath' setting.`
                );
                for (const item of items) { run.errored(item, msg); }
                resolve();
                return;
            }

            proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
            proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

            token.onCancellationRequested(() => proc.kill());

            proc.on('error', err => {
                const msg = new vscode.TestMessage(
                    `Failed to launch '${ppdExe}': ${err.message}. ` +
                    `Check the 'picoPanda.ppdPath' setting.`
                );
                for (const item of items) { run.errored(item, msg); }
                resolve();
            });

            proc.on('close', () => {
                // Strip ANSI escape codes.
                const raw = stdout || stderr;
                const clean = raw.replace(/\x1b\[[0-9;]*m/g, '');

                // Always feed compiler errors into the diagnostic system.
                this.diagnostics.update(raw);

                const hasResults = /^[PF]:/m.test(clean);
                if (!hasResults) {
                    // Compilation or discovery failure.
                    const errText = (stderr || stdout).trim() || 'Build failed';
                    const msg = new vscode.TestMessage(errText);
                    for (const item of items) { run.errored(item, msg); }
                } else {
                    this.diagnostics.clear(); // tests ran — no build errors
                    this.parseResults(clean, items, run);
                }

                resolve();
            });
        });
    }

    // ── output parsing ───────────────────────────────────────────────────────

    /**
     * Parses the test runner output and maps results to TestItems.
     *
     * Format:
     *   P:<name>              — test passed
     *   F:<name>              — test failed
     *     <file>:<line>: <expr>   — failure location (indented 2 spaces)
     *   DONE <pass>/<total>   — summary
     */
    private parseResults(
        output: string,
        items: vscode.TestItem[],
        run: vscode.TestRun
    ) {
        const byName = new Map(items.map(i => [i.label, i]));
        const seen = new Set<string>();

        const lines = output.split('\n');
        let i = 0;

        while (i < lines.length) {
            const line = lines[i];

            const pm = line.match(/^P:(\w+)/);
            const fm = line.match(/^F:(\w+)/);

            if (pm) {
                const name = pm[1];
                if (!seen.has(name)) {
                    seen.add(name);
                    const item = byName.get(name);
                    if (item) { run.passed(item); }
                }
                i++;

            } else if (fm) {
                const name = fm[1];
                i++;

                // Collect indented failure detail lines.
                const messages: vscode.TestMessage[] = [];
                while (i < lines.length && lines[i].startsWith('  ')) {
                    const detail = lines[i].trim();
                    // Format: /abs/path/file.ppd:<line>: <assert expression>
                    const dm = detail.match(/^(.+\.ppd):(\d+): (.+)$/);
                    if (dm) {
                        const [, file, lineStr, expr] = dm;
                        const msg = new vscode.TestMessage(expr);
                        msg.location = new vscode.Location(
                            vscode.Uri.file(file),
                            new vscode.Position(parseInt(lineStr) - 1, 0)
                        );
                        messages.push(msg);
                    } else if (detail) {
                        messages.push(new vscode.TestMessage(detail));
                    }
                    i++;
                }

                if (!seen.has(name)) {
                    seen.add(name);
                    const item = byName.get(name);
                    if (item) {
                        run.failed(
                            item,
                            messages.length
                                ? messages
                                : [new vscode.TestMessage('Test failed')]
                        );
                    }
                }

            } else {
                i++;
            }
        }

        // Items not reported in the output were not executed (e.g., early exit).
        for (const [name, item] of byName) {
            if (!seen.has(name)) {
                run.skipped(item);
            }
        }
    }

    // ── disposal ─────────────────────────────────────────────────────────────

    dispose() {
        this.controller.dispose();
        this.watcher.dispose();
    }
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** Walk up from [dir] to find the nearest directory containing ppd.cfg. */
function findProjectRoot(dir: string): string | undefined {
    let current = dir;
    while (true) {
        if (fs.existsSync(path.join(current, 'ppd.cfg'))) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) { return undefined; } // reached filesystem root
        current = parent;
    }
}
