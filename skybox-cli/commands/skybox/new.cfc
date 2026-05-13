/**
 *  Scaffold a SkyBox demo app from built-in templates
 *
 *  Creates a working demo application with a .bx listener, test files,
 *  and configuration. Available demos:
 *
 *    - echo        Echo server — sends back whatever you send
 *    - counter     Connection counter with persistent state
 *    - chatroom    Simple multi-client chat room
 *    - moonphase   Lunar phase calculator (text-based)
 *    - romannumeral Roman numeral converter
 *    - jsonfmt     JSON formatter/validator (manual structural validation)
 *    - textanalyzer  Text analysis (word count, char count, etc.)
 *    - todo        Simple todo list manager
 *
 *  {code:bash}
 *  box skybox new my-demo echo          # Scaffold echo demo
 *  box skybox new chat-app chatroom     # Scaffold chatroom demo
 *  box skybox new                       # List available demos
 *  {code}
 *
 *  Each demo is a self-contained project with build/test/dev/deploy scripts.
 **/
component {

    // ── DI ──
    property name="skyBoxService"  inject="SkyBoxService@skybox-cli";
    property name="print"          inject="PrintBuffer";

    // ── Available demo list ──
    variables.availableDemos = [
        { name : "echo",           description : "Echo server — sends back whatever you send" },
        { name : "counter",        description : "Connection counter with persistent state" },
        { name : "chatroom",       description : "Simple multi-client chat room" },
        { name : "moonphase",      description : "Lunar phase calculator (text-based)" },
        { name : "romannumeral",   description : "Roman numeral converter" },
        { name : "jsonfmt",        description : "JSON formatter/validator (manual structural validation)" },
        { name : "textanalyzer",   description : "Text analysis (word count, char count, etc.)" },
        { name : "todo",           description : "Simple todo list manager" }
    ];

    /**
     *  @name.hint        The name for the new demo app
     *  @demo.hint        The demo template to use (echo, counter, chatroom, etc.)
     *  @directory.hint   The directory to create the demo in (default: current directory)
     *  @list.hint        List available demos without creating one
     **/
    function run(
        string name          = "",
        string demo          = "",
        string directory     = getCWD(),
        boolean list        = false
    ) {
        if ( arguments.list || ( !arguments.name.len() && !arguments.demo.len() ) ) {
            listDemos();
            return;
        }

        // Validate demo name
        if ( arguments.demo.len() && !isValidDemo( arguments.demo ) ) {
            print.redLine( "Unknown demo: " & arguments.demo );
            print.line();
            listDemos();
            return;
        }

        // If no name provided, derive from demo
        var appName = arguments.name.len() ? arguments.name : arguments.demo & "-demo";

        // If no demo specified, default to echo
        var demoName = arguments.demo.len() ? arguments.demo : "echo";

        var targetDir = resolvePath( arguments.directory );
        if ( arguments.directory == getCWD() ) {
            targetDir = resolvePath( appName );
        }

        print.boldGreenLine( "=== SkyBox Demo Scaffold ===" );
        print.line( "  App:  " & appName );
        print.line( "  Demo: " & demoName );
        print.line( "  Dir:  " & targetDir );
        print.line();

        // Copy demo from the SkyBox examples directory
        var projectRoot = variables.skyBoxService.detectProjectRoot();
        if ( projectRoot.len() ) {
            var demoSrc = projectRoot & "/crates/matchbox-cf-worker/examples/" & demoName;

            if ( directoryExists( demoSrc ) ) {
                // Create target directory
                if ( !directoryExists( targetDir ) ) {
                    directoryCreate( targetDir );
                }

                // Copy demo files (excluding node_modules)
                directoryCopy(
                    demoSrc,
                    targetDir,
                    true,
                    function( path ) {
                        return !path.contains( "/node_modules/" ) && !path.contains( "\node_modules\" );
                    }
                );

                print.greenLine( "Demo [" & demoName & "] scaffolded successfully!" );
                print.line();
                print.cyanLine( "Next steps:" );
                print.greenLine( "  cd " & targetDir );
                print.greenLine( "  npm install" );
                print.greenLine( "  npm run build" );
                print.greenLine( "  npm run dev" );
                print.line();
                return;
            }
        }

        // Fallback: copy from module templates
        var templatesPath = variables.skyBoxService.getTemplatesPath();
        var demoTemplateDir = templatesPath & "/demos/" & demoName;

        if ( directoryExists( demoTemplateDir ) ) {
            if ( !directoryExists( targetDir ) ) {
                directoryCreate( targetDir );
            }
            directoryCopy( demoTemplateDir, targetDir, true );
            print.greenLine( "Demo [" & demoName & "] scaffolded from templates!" );
        } else {
            // Create a minimal demo from the init template
            print.yellowLine( "Demo template [" & demoName & "] not available locally." );
            print.yellowLine( "Scaffolding a basic project instead." );
            print.line();

            variables.skyBoxService.scaffoldProject(
                name      = appName,
                directory = targetDir
            );
        }

        print.line();
        print.cyanLine( "Next steps:" );
        print.greenLine( "  cd " & targetDir );
        print.greenLine( "  npm install" );
        print.greenLine( "  npm run build" );
        print.greenLine( "  npm run dev" );
    }

    // ── Private Helpers ──

    /**
     *  List available demos
     */
    private void function listDemos() {
        print.boldGreenLine( "Available SkyBox Demos" );
        print.line();

        for ( var demo in variables.availableDemos ) {
            print.green( "  #demo.name#" );
            var padding = 20 - demo.name.len();
            for ( var i = 1; i <= padding; i++ ) {
                print.text( " " );
            }
            print.line( "#demo.description#" );
        }

        print.line();
        print.cyanLine( "Usage: box skybox new <app-name> <demo-name>" );
        print.cyanLine( "Example: box skybox new my-chat chatroom" );
    }

    /**
     *  Check if a demo name is valid
     */
    private boolean function isValidDemo( required string demoName ) {
        for ( var demo in variables.availableDemos ) {
            if ( demo.name == demoName ) {
                return true;
            }
        }
        return false;
    }

}
