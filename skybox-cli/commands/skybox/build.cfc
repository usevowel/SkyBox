/**
 *  Build a SkyBox app — compile .bx sources into a WASM worker
 *
 *  Two modes:
 *
 *  1. Single source (default):
 *     box skybox build --src MyListener.bx --listener-class MyListener
 *
 *  2. Multi-source (full app):
 *     box skybox build --multi-source --src-dir src --listener-class AppListener
 *
 *  Multi-source mode finds all .bx files recursively in --src-dir,
 *  concatenates them into one merged source, and compiles as a single chunk.
 *
 *  {code:bash}
 *  box skybox build                                    # Single source, current dir
 *  box skybox build --multi-source --src-dir src        # Multi-file app
 *  box skybox build --src-dir src --listener-class AppListener
 *  {code}
 **/
component {

    // ── DI ──
    property name="skyBoxService" inject="SkyBoxService@skybox-cli";
    property name="print"         inject="PrintBuffer";

    /**
     *  @multi-source.hint        Enable multi-file build (concatenates all .bx files)
     *  @src-dir.hint             Source directory for multi-file builds (default: src/)
     *  @src.hint                 Path to single BoxLang source file
     *  @listener-class.hint      The BoxLang listener class name
     *  @state.hint               Initial listener state as JSON string
     *  @example-dir.hint         Path to the example app directory (default: current dir)
     **/
    function run(
        boolean multiSource    = false,
        string srcDir          = "src",
        string src             = "",
        string listenerClass   = "",
        string state           = "{}",
        string exampleDir      = getCWD()
    ) {
        var appDir = resolvePath( arguments.exampleDir );

        print.boldGreenLine( "=== SkyBox Build ===" );

        if ( arguments.multiSource ) {
            // ── Multi-source mode ──
            var srcPath = appDir & "/" & arguments.srcDir;

            if ( !arguments.listenerClass.len() ) {
                // Try to detect from src/Application.bx
                var appBx = srcPath & "/Application.bx";
                if ( fileExists( appBx ) ) {
                    arguments.listenerClass = "AppListener";
                    print.line( "  Detected Application.bx, using AppListener" );
                } else {
                    arguments.listenerClass = "AppListener";
                }
            }

            print.line( "  Mode:      Multi-source" );
            print.line( "  Src dir:   " & srcPath );
            print.line( "  Class:     " & arguments.listenerClass );
            print.line();

            var result = skyBoxService.buildMultiSource(
                srcDir      = srcPath,
                exampleDir  = appDir,
                mainClass   = arguments.listenerClass,
                stateJson   = arguments.state
            );

            if ( result.success ) {
                print.greenLine( "Build completed!" );
                print.line( "  WASM: " & result.wasmPath );
            } else {
                print.redLine( "Build failed: " & result.output );
            }

        } else {
            // ── Single source mode ──
            if ( !arguments.src.len() ) {
                // Auto-detect
                var candidates = [ "src/AppListener.bx", "src/main.bx" ];
                for ( var c in candidates ) {
                    if ( fileExists( appDir & "/" & c ) ) {
                        arguments.src = c;
                        break;
                    }
                }
                if ( !arguments.src.len() ) {
                    print.redLine( "Error: No source file specified and no default found." );
                    print.line( "Use --src to specify the .bx file." );
                    return;
                }
            }

            if ( !arguments.listenerClass.len() ) {
                // Derive from filename
                var fileName = getFileFromPath( arguments.src );
                arguments.listenerClass = fileName.replace( ".bx", "", "once" );
            }

            var sourcePath = appDir & "/" & arguments.src;
            if ( !fileExists( sourcePath ) ) {
                print.redLine( "Error: Source not found: " & sourcePath );
                return;
            }

            var projectRoot = skyBoxService.detectProjectRoot();
            if ( !projectRoot.len() ) {
                print.redLine( "Error: Not inside a SkyBox/Cargo project." );
                return;
            }

            var buildScript = projectRoot & "/crates/matchbox-cf-worker/examples/build.sh";
            print.line( "  Mode:      Single source" );
            print.line( "  Source:    " & arguments.src );
            print.line( "  Class:     " & arguments.listenerClass );
            print.line();

            if ( !fileExists( buildScript ) ) {
                print.redLine( "Error: Build script not found: " & buildScript );
                return;
            }

            try {
                var output = command( "!" & buildScript )
                    .params(
                        appDir,
                        arguments.src,
                        arguments.listenerClass,
                        arguments.state
                    )
                    .run( returnOutput = true );

                print.greenLine( "Build completed!" );
                print.line();
                print.line( output );
            } catch ( any e ) {
                print.redLine( "Build failed: " & e.message );
                if ( e.detail.len() ) {
                    print.redLine( e.detail );
                }
            }
        }
    }

}
