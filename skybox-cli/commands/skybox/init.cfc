/**
 *  Scaffold a new SkyBox project
 *
 *  {code:bash}
 *  box skybox init my-app              ## WebSocket-only (default)
 *  box skybox init my-app --type app   ## Full app structure
 *  {code}
 **/
component {

    // ── DI ──
    property name="skyBoxService" inject="SkyBoxService@skybox-cli";
    property name="print"         inject="PrintBuffer";
    property name="shell"         inject="shell";

    /**
     *  @name.hint             The name of your SkyBox app
     *  @projectType.hint      Project type: websocket (single file) or app (multi-file)
     *  @listener-class.hint   The BoxLang listener class name (auto-derived)
     *  @force.hint            Overwrite existing files
     **/
    function run(
        string name            = "my-skybox-app",
        string projectType     = "",
        string listenerClass   = "",
        boolean force          = false
    ) {
        // Default project type
        if ( !arguments.projectType.len() ) {
            arguments.projectType = "websocket";
        }

        var targetDir = shell.pwd();

        // If name was provided, create a subdirectory
        if ( arguments.name != "my-skybox-app" ) {
            targetDir = targetDir & "/" & arguments.name;
        }

        // Validate target directory
        if ( directoryExists( targetDir ) && !force ) {
            var listing = directoryList( targetDir, false, "name" );
            if ( listing.len() > 0 ) {
                print.yellowLine( "Directory [" & targetDir & "] is not empty." );
                if ( !confirm( "Scaffold into a non-empty directory? (y/n) " ) ) {
                    print.redLine( "Aborted." );
                    return;
                }
            }
        }

        var templates = skyBoxService.getTemplates();
        var templateLabel = "unknown";
        if ( templates.keyExists( arguments.projectType ) ) {
            templateLabel = templates[ arguments.projectType ].label;
        }

        print.boldGreenLine( "=== SkyBox Project Scaffold ===" );
        print.line( "  Name:     " & arguments.name );
        print.line( "  Dir:      " & targetDir );
        print.line( "  Type:     " & arguments.projectType & " (" & templateLabel & ")" );
        print.line( "  Class:    " & ( arguments.listenerClass.len() ? arguments.listenerClass : "(auto)" ) );
        print.line();

        var result = skyBoxService.scaffoldProject(
            name           = arguments.name,
            directory      = targetDir,
            listenerClass  = arguments.listenerClass,
            template       = arguments.projectType
        );

        if ( result.success ) {
            print.greenLine( "Project scaffolded successfully!" );
            print.line();

            print.cyanLine( "Next steps:" );
            print.greenLine( "  cd " & targetDir );

            if ( arguments.projectType == "app" ) {
                print.greenLine( "  npm install          ## Install dependencies" );
                print.greenLine( "  npm run dev          ## Build + dev with live reload" );
                print.greenLine( "  npm run deploy       ## Build + deploy" );
            } else {
                print.greenLine( "  npm install          ## Install wrangler" );
                print.greenLine( "  npm run build        ## Build the WASM worker" );
                print.greenLine( "  npm run dev          ## Start local dev server" );
                print.greenLine( "  npm run deploy       ## Deploy to Cloudflare" );
            }
            print.line();

            print.yellowLine( "Created files:" );
            for ( var msg in result.messages ) {
                print.line( "  " & msg );
            }
        } else {
            print.redLine( "Scaffolding failed." );
            for ( var msg in result.messages ) {
                print.redLine( "  " & msg );
            }
        }
    }

}
