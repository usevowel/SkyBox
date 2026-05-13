/**
 *  SkyBoxService — shared business logic for SkyBox CLI commands
 *
 *  Provides utility methods for:
 *    - Detecting the Rust/Cargo project root
 *    - Running the build pipeline (cargo, wasm-bindgen, cf-worker-builder)
 *    - Scaffolding project files from templates
 *    - Multi-file BoxLang compilation support
 *
 *  @singleton
 *  @inject  injector
 */
component {

    // ── DI ──
    property name="fileSystemUtil" inject="FileSystem";
    property name="print"          inject="PrintBuffer";
    property name="shell"          inject="shell";
    property name="settings"       inject="commandbox:moduleSettings:skybox-cli";

    // ── Constants ──
    variables.SKYBOX_BUILD_SCRIPT  = "crates/matchbox-cf-worker/examples/build.sh";
    variables.SKYBOX_WRANGLER_TOML = "wrangler.toml";
    variables.SKYBOX_PACKAGE_JSON  = "package.json";
    variables.SKYBOX_MCF_WORKER_JS = "mcf-worker.js";

    // ── Available template types ──
    variables.TEMPLATES = {
        websocket : {
            dir      : "init/",
            label    : "WebSocket-only (single listener .bx file)"
        },
        app : {
            dir      : "app/",
            label    : "Full app (Application.bx, handlers/, models/, listeners/)"
        }
    };

    /**
     *  Get available template types
     */
    function getTemplates() {
        return variables.TEMPLATES;
    }

    /**
     *  Create a new SkyBox project scaffold
     *
     *  @name           The name of the project/app
     *  @directory      The target directory for the new project
     *  @listenerClass  The BoxLang listener class name
     *  @template       Template type: "websocket" or "app"
     *
     *  @return         Struct with { success, path, messages }
     */
    function scaffoldProject(
        required string name,
        required string directory,
        string listenerClass = "",
        string template      = "websocket"
    ) {
        // Validate template type
        if ( !variables.TEMPLATES.keyExists( template ) ) {
            return {
                success  : false,
                path     : directory,
                messages : [ "Unknown template: " & template & ". Use: websocket or app" ]
            };
        }

        var result = {
            success  : true,
            path     : directory,
            messages : []
        };

        if ( !listenerClass.len() ) {
            arguments.listenerClass = listenerClassFromName( arguments.name );
        }

        // Create directory structure
        if ( !directoryExists( directory ) ) {
            directoryCreate( directory );
            result.messages.append( "Created directory: " & directory );
        }

        if ( template == "websocket" ) {
            scaffoldWebSocket( arguments, result );
        } else if ( template == "app" ) {
            scaffoldApp( arguments, result );
        }

        return result;
    }

    /**
     *  Compile multiple BoxLang source files into a single WASM chunk
     *
     *  Reads all .bx files from a source directory recursively,
     *  concatenates them into a single source file, then runs
     *  the standard build pipeline.
     *
     *  @srcDir         Directory containing .bx source files
     *  @exampleDir     The example app directory
     *  @mainClass      The listener class (entry point)
     *  @stateJson      Optional initial state JSON
     *
     *  @return         Struct with { success, output, wasmPath }
     */
    function buildMultiSource(
        required string srcDir,
        required string exampleDir,
        required string mainClass,
        string stateJson = "{}"
    ) {
        var projectRoot = detectProjectRoot();
        if ( !projectRoot.len() ) {
            return { success : false, output : "Not inside a SkyBox/Cargo project." };
        }

        // Find all .bx files recursively in the source directory
        var bxFiles = findBxFilesRecursive( srcDir );
        if ( !bxFiles.len() ) {
            return { success : false, output : "No .bx files found in " & srcDir };
        }

        // Concatenate all sources into one merged file
        var mergedDir  = exampleDir & "/.skybox-build/";
        ensureDir( mergedDir );
        var mergedFile = mergedDir & "merged_source.bx";

        var mergedContent = "";
        for ( var bxFile in bxFiles ) {
            mergedContent &= fileRead( bxFile ) & chr(10) & chr(10);
        }
        fileWrite( mergedFile, mergedContent.trim() );

        // Run the build pipeline on the merged source
        var buildScript = projectRoot & "/" & variables.SKYBOX_BUILD_SCRIPT;
        if ( !fileExists( buildScript ) ) {
            return { success : false, output : "Build script not found: " & buildScript };
        }

        try {
            var cmd = command( "!" & buildScript )
                .params(
                    exampleDir,
                    mergedFile,
                    mainClass,
                    stateJson
                )
                .run( returnOutput = true );

            return {
                success  : true,
                output   : cmd,
                wasmPath : exampleDir & "/dist/worker.wasm"
            };
        } catch ( any e ) {
            return {
                success : false,
                output  : "Build failed: " & e.message & chr(10) & e.detail
            };
        }
    }

    /**
     *  Detect the SkyBox / Cargo project root
     */
    function detectProjectRoot() {
        var cwd = fileSystemUtil.resolvePath( shell.pwd() );
        for ( var i = 1; i <= 10; i++ ) {
            if ( fileExists( cwd & "/Cargo.toml" ) ) {
                return cwd;
            }
            var parent = getDirectoryFromPath( cwd );
            if ( parent == cwd ) { break; }
            cwd = parent;
        }
        return "";
    }

    // ── Private: Scaffold Methods ──

    /**
     *  Scaffold a websocket-only project (single listener file)
     */
    private void function scaffoldWebSocket(
        required struct args,
        required struct result
    ) {
        var dir = args.directory & "/";
        ensureDir( dir & "src/" );
        ensureDir( dir & "/dist/" );

        var templatesPath = getTemplatesPath();
        var initDir       = templatesPath & "init/";

        writeFromTemplate(
            initDir & "main.bx",
            dir & "src/" & args.listenerClass & ".bx",
            { "{{listenerClass}}" : args.listenerClass }
        );
        result.messages.append( "Created: src/" & args.listenerClass & ".bx" );

        writeFromTemplate(
            initDir & "wrangler.toml",
            dir & variables.SKYBOX_WRANGLER_TOML,
            { "{{appName}}" : "skybox-" & args.name }
        );
        result.messages.append( "Created: " & variables.SKYBOX_WRANGLER_TOML );

        writeFromTemplate(
            initDir & "package.json",
            dir & variables.SKYBOX_PACKAGE_JSON,
            {
                "{{appName}}"       : args.name,
                "{{listenerClass}}" : args.listenerClass,
                "{{buildScript}}"   : variables.SKYBOX_BUILD_SCRIPT
            }
        );
        result.messages.append( "Created: " & variables.SKYBOX_PACKAGE_JSON );

        copyMcFWorker( dir );
        result.messages.append( "Created: " & variables.SKYBOX_MCF_WORKER_JS );
    }

    /**
     *  Scaffold a full app project (Application.bx + multi-file structure)
     */
    private void function scaffoldApp(
        required struct args,
        required struct result
    ) {
        var dir = args.directory & "/";
        ensureDir( dir & "src/listeners/" );
        ensureDir( dir & "src/handlers/" );
        ensureDir( dir & "src/models/" );
        ensureDir( dir & "/dist/" );

        var templatesPath = getTemplatesPath();
        var appDir        = templatesPath & "app/";

        // Copy Application.bx
        writeFromTemplate(
            appDir & "Application.bx",
            dir & "src/Application.bx",
            {
                "{{appName}}"       : args.name,
                "{{listenerClass}}" : args.listenerClass
            }
        );
        result.messages.append( "Created: src/Application.bx" );

        // Copy listener
        copyTemplateFile(
            appDir & "listeners/AppListener.bx",
            dir & "src/listeners/" & args.listenerClass & ".bx"
        );
        result.messages.append( "Created: src/listeners/" & args.listenerClass & ".bx" );

        // Copy handlers
        copyTemplateDir( appDir & "handlers/", dir & "src/handlers/" );
        result.messages.append( "Created: src/handlers/ (MessageRouter.bx)" );

        // Copy models
        copyTemplateDir( appDir & "models/", dir & "src/models/" );
        result.messages.append( "Created: src/models/ (AppState.bx)" );

        // Write wrangler.toml
        writeFromTemplate(
            appDir & "wrangler.toml",
            dir & variables.SKYBOX_WRANGLER_TOML,
            { "{{appName}}" : "skybox-" & args.name }
        );
        result.messages.append( "Created: " & variables.SKYBOX_WRANGLER_TOML );

        // Write package.json with watch-mode scripts
        writeFromTemplate(
            appDir & "package.json",
            dir & variables.SKYBOX_PACKAGE_JSON,
            {
                "{{appName}}"       : args.name,
                "{{listenerClass}}" : args.listenerClass
            }
        );
        result.messages.append( "Created: " & variables.SKYBOX_PACKAGE_JSON );

        // Copy dev-watch.js helper
        copyTemplateFile(
            appDir & "dev-watch.js",
            dir & "dev-watch.js"
        );
        result.messages.append( "Created: dev-watch.js (live reload helper)" );

        // Copy mcf-worker.js
        copyMcFWorker( dir );
        result.messages.append( "Created: " & variables.SKYBOX_MCF_WORKER_JS );
    }

    // ── Private: File Helpers ──

    /**
     *  Derive a listener class name from an app name
     */
    private string function listenerClassFromName( required string name ) {
        var cleaned = name.reReplace( "[^a-zA-Z0-9]", "", "all" );
        if ( !cleaned.len() ) { return "AppListener"; }
        return cleaned.left( 1 ).ucase() & cleaned.right( cleaned.len() - 1 ) & "Listener";
    }

    /**
     *  Get the path to this module's templates directory
     *
     *  Reads from ModuleConfig settings (stored during configure()).
     *  Falls back to resolving relative to this CFC in dev mode.
     */
    private string function getTemplatesPath() {
        if ( !isNull( variables.settings ) && isStruct( variables.settings ) && variables.settings.keyExists( "templatesPath" ) ) {
            return variables.settings.templatesPath & "/";
        }
        // Fallback: resolve relative to this file's location
        var thisPath = getCurrentTemplatePath();
        var moduleRoot = getDirectoryFromPath( getDirectoryFromPath( thisPath ) );
        return moduleRoot & "templates/";
    }

    /**
     *  Ensure a directory exists
     */
    private void function ensureDir( required string path ) {
        if ( !directoryExists( path ) ) {
            directoryCreate( path );
        }
    }

    /**
     *  Read a template file, substitute placeholders, write to destination
     */
    private void function writeFromTemplate(
        required string templateFile,
        required string destFile,
        struct substitutions = {}
    ) {
        if ( !fileExists( templateFile ) ) {
            throw( message = "Template not found: " & templateFile );
        }

        var content = fileRead( templateFile );
        for ( var placeholder in substitutions ) {
            content = content.replace( placeholder, substitutions[ placeholder ], "all" );
        }
        fileWrite( destFile, content.trim() );
    }

    /**
     *  Copy a single file from template to destination
     */
    private void function copyTemplateFile(
        required string source,
        required string dest
    ) {
        if ( !fileExists( source ) ) {
            throw( message = "Template file not found: " & source );
        }
        fileCopy( source, dest );
    }

    /**
     *  Copy a directory of template files to destination (non-recursive)
     */
    private void function copyTemplateDir(
        required string sourceDir,
        required string destDir
    ) {
        if ( !directoryExists( sourceDir ) ) {
            throw( message = "Template directory not found: " & sourceDir );
        }
        ensureDir( destDir );

        var files = directoryList( sourceDir, false, "path" );
        for ( var file in files ) {
            var fileName = getFileFromPath( file );
            fileCopy( file, destDir & fileName );
        }
    }

    /**
     *  Find all .bx files recursively
     */
    private array function findBxFilesRecursive( required string dir ) {
        var results = [];
        if ( !directoryExists( dir ) ) { return results; }

        var items = directoryList( dir, false, "query" );
        for ( var item in items ) {
            var fullPath = dir & "/" & item.name;
            if ( item.type == "dir" ) {
                results.appendAll( findBxFilesRecursive( fullPath ) );
            } else if ( item.name.endsWith( ".bx" ) ) {
                results.append( fullPath );
            }
        }
        return results;
    }

    /**
     *  Copy mcf-worker.js — from crates shell or templates
     */
    private void function copyMcFWorker( required string directory ) {
        var projectRoot = detectProjectRoot();
        if ( projectRoot.len() ) {
            var shellSource = projectRoot & "/crates/matchbox-cf-worker/shell/mcf-worker.js";
            if ( fileExists( shellSource ) ) {
                fileCopy( shellSource, directory & variables.SKYBOX_MCF_WORKER_JS );
                return;
            }
        }

        var templatesPath = getTemplatesPath();
        var templateFile  = templatesPath & "init/mcf-worker.js";
        if ( fileExists( templateFile ) ) {
            fileCopy( templateFile, directory & variables.SKYBOX_MCF_WORKER_JS );
            return;
        }

        throw( message = "Could not locate mcf-worker.js template" );
    }

}
