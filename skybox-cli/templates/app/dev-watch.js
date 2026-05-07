/**
 *  dev-watch.js — Live Reload for SkyBox Apps
 *
 *  Watches src/**/*.bx files for changes, rebuilds the WASM,
 *  and restarts the wrangler dev server.
 *
 *  Usage:
 *    node dev-watch.js [--port 8787] [--ip 127.0.0.1]
 *
 *  Requires:
 *    - chokidar (npm install chokidar)
 *    - wrangler (npm install wrangler)
 *    - The SkyBox build pipeline (cargo + wasm-bindgen + cf-worker-builder)
 */

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

// ── Config ──
const SRC_DIR = path.resolve(__dirname, 'src');
const BUILD_SCRIPT = path.resolve(__dirname, '../../crates/matchbox-cf-worker/examples/build.sh');

const args = process.argv.slice(2);
const PORT = parseInt(args[args.indexOf('--port') + 1] || process.env.PORT || '8787', 10);
const IP = args[args.indexOf('--ip') + 1] || process.env.IP || '127.0.0.1';

let wranglerProcess = null;
let isBuilding = false;
let pendingRebuild = false;

// ── Dynamic import for chokidar (ESM module) ──
async function loadChokidar() {
    try {
        // Try CJS require first
        return require('chokidar');
    } catch (e) {
        // Fall back to dynamic import for ESM
        const mod = await import('chokidar');
        return mod.default || mod;
    }
}

// ── Find all .bx files recursively ──
function findBxFiles(dir) {
    const results = [];
    if (!fs.existsSync(dir)) return results;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...findBxFiles(fullPath));
        } else if (entry.name.endsWith('.bx')) {
            results.push(fullPath);
        }
    }
    return results;
}

// ── Build the project ──
async function rebuild() {
    if (isBuilding) {
        pendingRebuild = true;
        return;
    }

    isBuilding = true;
    console.log(`\n[${new Date().toLocaleTimeString()}] File change detected, rebuilding...`);

    try {
        // Run the build
        execSync('box skybox build --multi-source --src-dir src', {
            cwd: __dirname,
            stdio: 'inherit',
            timeout: 120000
        });
        console.log(`[${new Date().toLocaleTimeString()}] Build complete, restarting dev server...`);

        // Restart wrangler
        restartWrangler();
    } catch (err) {
        console.error(`[${new Date().toLocaleTimeString()}] Build failed:`, err.message);
    }

    isBuilding = false;

    if (pendingRebuild) {
        pendingRebuild = false;
        await rebuild();
    }
}

// ── Start wrangler dev server ──
function startWrangler() {
    if (wranglerProcess) {
        wranglerProcess.kill('SIGTERM');
    }

    const wranglerPath = path.resolve(__dirname, 'node_modules/.bin/wrangler');
    const wranglerCmd = fs.existsSync(wranglerPath) ? wranglerPath : 'npx';

    console.log(`Starting wrangler dev on http://${IP}:${PORT}...`);

    wranglerProcess = spawn(wranglerCmd, [
        'dev', '--local',
        '--port', String(PORT),
        '--ip', IP
    ], {
        cwd: __dirname,
        stdio: 'inherit',
        env: { ...process.env }
    });

    wranglerProcess.on('close', (code) => {
        console.log(`Wrangler exited with code ${code}`);
        wranglerProcess = null;
    });
}

// ── Restart wrangler ──
function restartWrangler() {
    if (wranglerProcess) {
        wranglerProcess.kill('SIGTERM');
        // Give it a moment to release the port
        setTimeout(startWrangler, 500);
    } else {
        startWrangler();
    }
}

// ── Main ──
async function main() {
    console.log('=== SkyBox Dev Watch ===');
    console.log(`  Watch dir: ${SRC_DIR}`);
    console.log(`  Port:      ${PORT}`);
    console.log(`  IP:        ${IP}`);
    console.log('');

    // Initial build
    console.log('Running initial build...');
    try {
        execSync('box skybox build --multi-source --src-dir src', {
            cwd: __dirname,
            stdio: 'inherit',
            timeout: 120000
        });
        console.log('Initial build complete.');
    } catch (err) {
        console.error('Initial build failed:', err.message);
        console.error('Starting dev server anyway...');
    }

    // Start wrangler
    startWrangler();

    // Watch for changes
    console.log(`\nWatching for changes in ${SRC_DIR}...`);
    console.log('Press Ctrl+C to stop.\n');

    try {
        const chokidar = await loadChokidar();
        const watcher = chokidar.watch(`${SRC_DIR}/**/*.bx`, {
            ignored: /(^|[\/\\])\../,
            persistent: true,
            ignoreInitial: true
        });

        watcher.on('change', (filePath) => {
            console.log(`  Changed: ${path.relative(__dirname, filePath)}`);
            rebuild();
        });

        watcher.on('add', (filePath) => {
            console.log(`  Added: ${path.relative(__dirname, filePath)}`);
            rebuild();
        });

        watcher.on('unlink', (filePath) => {
            console.log(`  Removed: ${path.relative(__dirname, filePath)}`);
            rebuild();
        });

        // Handle graceful shutdown
        process.on('SIGINT', () => {
            console.log('\nShutting down...');
            if (wranglerProcess) wranglerProcess.kill();
            watcher.close();
            process.exit(0);
        });

        process.on('SIGTERM', () => {
            if (wranglerProcess) wranglerProcess.kill();
            watcher.close();
            process.exit(0);
        });

    } catch (err) {
        console.error('Failed to start file watcher:', err.message);
        console.error('Make sure chokidar is installed: npm install chokidar');
        process.exit(1);
    }
}

main();
