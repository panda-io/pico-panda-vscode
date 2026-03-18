import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { PicoPandaDiagnostics } from './diagnostics';

/** Runs ppd CLI commands and streams output to the Output Channel. */
export class PicoPandaBuilder implements vscode.Disposable {
    private readonly output = vscode.window.createOutputChannel('Pico Panda');

    constructor(private readonly diagnostics: PicoPandaDiagnostics) {}

    /** Run `ppd <args>` in [cwd], streaming output. Returns true on success. */
    async run(args: string[], cwd: string): Promise<boolean> {
        const ppdExe = vscode.workspace
            .getConfiguration('picoPanda')
            .get<string>('ppdPath', 'ppd');

        this.output.show(/* preserveFocus */ true);
        this.output.appendLine(`> ppd ${args.join(' ')}`);
        this.diagnostics.clear();

        return new Promise(resolve => {
            let combined = '';

            let proc: ReturnType<typeof spawn>;
            try {
                proc = spawn(ppdExe, args, { cwd });
            } catch (err) {
                this.output.appendLine(`error: could not launch '${ppdExe}': ${err}`);
                resolve(false);
                return;
            }

            const onData = (d: Buffer) => {
                const text = d.toString();
                this.output.append(text);
                combined += text;
            };

            proc.stdout?.on('data', onData);
            proc.stderr?.on('data', onData);

            proc.on('error', err => {
                this.output.appendLine(
                    `error: could not launch '${ppdExe}': ${err.message}\n` +
                    `Check the 'picoPanda.ppdPath' setting.`
                );
                resolve(false);
            });

            proc.on('close', code => {
                this.diagnostics.update(combined);
                if (code === 0) {
                    this.output.appendLine('Done.');
                } else {
                    this.output.appendLine(`Failed (exit ${code}).`);
                }
                resolve(code === 0);
            });
        });
    }

    dispose() {
        this.output.dispose();
    }
}
