/**
 *  Start the SkyBox local development server
 *
 *  Two modes:
 *
 *  1. Standard (default):
 *     Builds the project, then starts wrangler dev --local
 *
 *  2. Watch mode (--watch):
 *     Uses the dev-watch.js helper (chokidar) to watch all .bx files in
 *     src/ for changes, auto-rebuild, and restart the dev server.
 *
 *  {code:bash}
 *  box skybox dev                    # Build + wrangler dev --local
 *  box skybox dev --watch            # Live reload when .bx files change
 *  box skybox dev --port 8788        # Custom port
 *  box skybox dev --skip-build       # Skip initial build
 *  {code}
 **/
component {

    // ── DI ──
    property name="skyBoxService" inject="SkyBoxService@skybox-cli";
    property name="print"         inject="PrintBuffer";

    /**
     *  @port.hint           The port to run the dev server on
     *  @ip.hint             The IP address to bind to
     *  @local-protocol.hint The protocol to use (http, https)
     *  @skip-build.hint     Skip the build step
     *  @watch.hint          Enable live reload on .bx file changes
     **/
    function run(
        numeric port            = 8787,
        string ip               = "127.0.0.1",
        string localProtocol    = "http",
        boolean skipBuild       = false,
        boolean watch           = false
    ) {
        var appDir = getCWD();

        if ( arguments.watch ) {
            // ── Watch mode (live reload) ──
            runWatchMode( argumentCollection = arguments );
            return;
        }

        // ── Standard mode ──
        print.boldGreenLine( "=== SkyBox Dev Server ===" );
        print.line( "  Port: " & arguments.port );
        print.line( "  IP:   " & arguments.ip );
        print.line();

        // Build first unless skipped
        if ( !arguments.skipBuild ) {
            print.yellowLine( "Building project..." );
            print.line();

            try {
                var buildOutput = command( "skybox build" ).run( returnOutput = true );
                print.line( buildOutput );
                print.line();
            } catch ( any e ) {
                print.redLine( "Build failed: " & e.message );
                if ( !confirm( "Continue to dev server anyway? (y/n) " ) ) {
                    print.redLine( "Aborted." );
                    return;
                }
                print.line();
            }
        }

        // Check if wrangler is available
        var wranglerPath = getWranglerPath( appDir );

        print.greenLine( "Starting wrangler dev server..." );
        print.line( "  " & arguments.localProtocol & "://" & arguments.ip & ":" & arguments.port );
        print.line( "  (Press Ctrl+C to stop)" );
        print.line();

        try {
            command( "!" & wranglerPath )
                .params(
                    "dev",
                    "--local",
                    port = arguments.port,
                    ip = arguments.ip,
                    localProtocol = arguments.localProtocol
                )
                .run();
        } catch ( any e ) {
            print.redLine( "Dev server stopped: " & e.message );
        }
    }

    // ── Private: Watch Mode ──

    /**
     *  Run the dev server with live reload
     */
    private void function runWatchMode(
        numeric port            = 8787,
        string ip               = "127.0.0.1",
        boolean skipBuild       = false
    ) {
        var appDir = getCWD();

        print.boldGreenLine( "=== SkyBox Dev Watch (Live Reload) ===" );
        print.line( "  Port: " & arguments.port );
        print.line( "  IP:   " & arguments.ip );
        print.line();

        // Check for dev-watch.js (app template) or use fallback
        var watchScript = appDir & "/dev-watch.js";
        if ( fileExists( watchScript ) ) {
            print.greenLine( "Using dev-watch.js helper..." );
            print.line();

            try {
                command( "!node" )
                    .params(
                        watchScript,
                        "--port", arguments.port,
                        "--ip", arguments.ip
                    )
                    .run();
            } catch ( any e ) {
                print.redLine( "Watch mode stopped: " & e.message );
            }
            return;
        }

        // Fallback: use Node.js inotify-based watcher
        print.yellowLine( "dev-watch.js not found. Using built-in file watcher..." );
        print.line();

        // Build first
        if ( !arguments.skipBuild ) {
            print.yellowLine( "Running initial build..." );
            try {
                command( "skybox build --multi-source --src-dir src" ).run( returnOutput = true );
            } catch ( any e ) {
                print.redLine( "Initial build failed: " & e.message );
                if ( !confirm( "Continue anyway? (y/n) " ) ) {
                    return;
                }
            }
            print.line();
        }

        print.greenLine( "Starting wrangler dev server with file watching..." );
        print.line();
        print.line( "  Watching: " & appDir & "/src/ (all .bx files)" );
        print.line( "  (Press Ctrl+C to stop)" );
        print.line();

        try {
            command( "!node" )
                .params(
                    "-e", buildWatchScript(
                        appDir,
                        arguments.port,
                        arguments.ip
                    )
                )
                .run();
        } catch ( any e ) {
            print.redLine( "Watch mode failed: " & e.message );
        }
    }

    /**
     *  Build an inline Node.js watch script when dev-watch.js is not available
     */
    private string function buildWatchScript(
        required string appDir,
        required numeric port,
        required string ip
    ) {
        var script = "
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const appDir = '" & appDir & "';
const PORT = " & port & ";
const IP = '" & ip & "';
let wrangler = null;
let building = false;
let pending = false;

function findBxFiles(dir) {
    let results = [];
    if (!fs.existsSync(dir)) return results;
    for (const e of fs.readdirSync(dir, {withFileTypes:true})) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) results.push(...findBxFiles(p));
        else if (e.name.endsWith('.bx')) results.push(p);
    }
    return results;
}

function rebuild() {
    if (building) { pending = true; return; }
    building = true;
    console.log('[' + new Date().toLocaleTimeString() + '] Change detected, rebuilding...');
    try {
        execSync('box skybox build --multi-source --src-dir src', {
            cwd: appDir, stdio: 'inherit', timeout: 120000
        });
        if (wrangler) { wrangler.kill('SIGTERM'); }
        setTimeout(startWrangler, 500);
    } catch(e) {
        console.error('Build failed:', e.message);
    }
    building = false;
    if (pending) { pending = false; rebuild(); }
}

function startWrangler() {
    const wPath = path.join(appDir, 'node_modules/.bin/wrangler');
    const cmd = fs.existsSync(wPath) ? wPath : 'npx';
    wrangler = spawn(cmd, ['dev','--local','--port',String(PORT),'--ip',IP], {
        cwd: appDir, stdio: 'inherit'
    });
    wrangler.on('close', (c) => { wrangler = null; });
}

console.log('Initial build...');
try { execSync('box skybox build --multi-source --src-dir src', {cwd:appDir, stdio:'inherit', timeout:120000}); } catch(e) {}
startWrangler();

const chokidar = require('chokidar');
const watcher = chokidar.watch(appDir + '/src/**/*.bx', {ignoreInitial:true});
watcher.on('change', rebuild).on('add', rebuild).on('unlink', rebuild);

process.on('SIGINT', () => { if(wrangler) wrangler.kill(); watcher.close(); process.exit(0); });
process.on('SIGTERM', () => { if(wrangler) wrangler.kill(); watcher.close(); process.exit(0); });
";
        return script;
    }

    // ── Private: Utility ──

    /**
     *  Find wrangler binary path
     */
    private string function getWranglerPath( required string appDir ) {
        var localPath = appDir & "/node_modules/.bin/wrangler";
        if ( fileExists( localPath ) ) {
            return localPath;
        }
        return "npx";
    }

}
