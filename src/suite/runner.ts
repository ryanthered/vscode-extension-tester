'use strict';

import { VSBrowser } from '../browser';
import * as fs from 'fs-extra';
import Mocha = require('mocha');
import * as glob from 'glob';
import { CodeUtil, ReleaseQuality } from '../util/codeUtil';
import * as path from 'path';
import * as yaml from 'js-yaml';
import sanitize = require('sanitize-filename');
import { logging } from 'selenium-webdriver';

/**
 * Mocha runner wrapper
 */
export class VSRunner {
    private mocha: Mocha;
    private chromeBin: string;
    private customSettings: Object;
    private codeVersion: string;
    private cleanup: boolean;

    constructor(bin: string, codeVersion: string, customSettings: Object = {}, cleanup: boolean = false, config?: string) {
        const conf = this.loadConfig(config);
        this.mocha = new Mocha(conf);
        this.chromeBin = bin;
        this.customSettings = customSettings;
        this.codeVersion = codeVersion;
        this.cleanup = cleanup; 
    }

    /**
     * Set up mocha suite, add vscode instance handling, run tests
     * @param testFilesPattern glob pattern of test files to run
     * @param logLevel The logging level for the Webdriver
     * @return The exit code of the mocha process
     */
    runTests(testFilesPattern: string, code: CodeUtil, logLevel: logging.Level = logging.Level.INFO): Promise<number> {
        return new Promise(resolve => {
            let self = this;
            const releaseType = path.basename(this.chromeBin).toLowerCase().includes('insider') ? ReleaseQuality.Insider : ReleaseQuality.Stable;
            let browser: VSBrowser = new VSBrowser(this.codeVersion, releaseType, this.customSettings, logLevel);
            const universalPattern = testFilesPattern.replace(/'/g, '');
            const testFiles = glob.sync(universalPattern);
    
            testFiles.forEach((file) => {
                if (fs.existsSync(file) && file.substr(-3) === '.js') {
                    this.mocha.addFile(file);
                }
            });
    
            this.mocha.suite.afterEach(async function () {
                if (this.currentTest && this.currentTest.state !== 'passed') {
                    try {
                        const filename = sanitize(this.currentTest.fullTitle());
                        await browser.takeScreenshot(filename);
                    } catch (err) {
                        console.log('Screenshot capture failed.', err);
                    }
                }
            });
    
            this.mocha.suite.beforeAll(async function () {
                this.timeout(45000);
                const start = Date.now();
                await browser.start(self.chromeBin);
                await browser.waitForWorkbench();
                await new Promise((res) => { setTimeout(res, 2000); });
                console.log(`Browser ready in ${Date.now() - start} ms`);
                console.log('Launching tests...');
            });
    
            this.mocha.suite.afterAll(async function() {
                this.timeout(15000);
                await browser.quit();
    
                code.uninstallExtension(self.cleanup);
            });
    
            this.mocha.run((failures) => {
                process.exitCode = failures ? 1 : 0;
                resolve(process.exitCode);
            });
        });
    }

    private loadConfig(config?: string): Mocha.MochaOptions {
        const defaultFiles = ['.mocharc.js', '.mocharc.json', '.mocharc.yml', '.mocharc.yaml']
        let conf: Mocha.MochaOptions = {};
        let file = config;
        if (!config) {
            file = path.resolve('.')
            for (let i = 0; i < defaultFiles.length; i++) {
                if (fs.existsSync(path.join(file, defaultFiles[i]))) {
                    file = path.join(file, defaultFiles[i]);
                    break;
                }
            }
        }

        if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
            console.log(`Loading mocha configuration from ${file}`);
            if (/\.(yml|yaml)$/.test(file)) {
                try {
                    conf = yaml.load(fs.readFileSync(file, 'utf-8')) as Mocha.MochaOptions;
                } catch (err) {
                    console.log('Invalid mocha configuration file, will be ignored');
                }
            } else if (/\.(js|json)$/.test(file)) {
                try {
                    conf = require(path.resolve(file));
                } catch (err) {
                    console.log('Invalid mocha configuration file, will be ignored');
                }
            } else {
                console.log('Unsupported mocha configuration file extension, make sure to use .js, .json, .yml or .yaml file');
            }
        }
        return conf;
    }
}