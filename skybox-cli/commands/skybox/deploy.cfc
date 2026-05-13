/**
 *  Deploy a SkyBox app to Cloudflare Workers
 *
 *  Builds the project and deploys via wrangler.
 *
 *  {code:bash}
 *  box skybox deploy                 # Build + wrangler deploy
 *  box skybox deploy --env staging   # Deploy to staging environment
 *  box skybox deploy --dry-run       # Preview without deploying
 *  box skybox deploy --skip-build    # Skip build, just deploy
 *  {code}
 *
 *  Requires:
 *    - wrangler CLI configured with Cloudflare credentials
 *    - wrangler.toml with account_id set
 *    - npm dependencies installed
 **/
component {

    // ── DI ──
    property name="skyBoxService" inject="SkyBoxService@skybox-cli";
    property name="print"         inject="PrintBuffer";

    /**
     *  @env.hint            The wrangler environment to deploy to (e.g., staging, production)
     *  @dry-run.hint        Preview deployment without deploying
     *  @skip-build.hint     Skip the build step
     **/
    function run(
        string env          = "",
        boolean dryRun     = false,
        boolean skipBuild  = false
    ) {
        print.boldGreenLine( "=== SkyBox Deploy ===" );
        if ( arguments.env.len() ) {
            print.line( "  Environment: " & arguments.env );
        }
        if ( arguments.dryRun ) {
            print.yellowLine( "  DRY RUN - no deployment will be made" );
        }
        print.line();

        // Build first unless skipped
        if ( !arguments.skipBuild ) {
            print.yellowLine( "Building project before deployment..." );
            print.line();

            try {
                var buildOutput = command( "skybox build" ).run( returnOutput = true );
                print.line( buildOutput );
                print.line();
            } catch ( any e ) {
                print.redLine( "Build failed: " & e.message );
                if ( !confirm( "Continue to deploy anyway? (y/n) " ) ) {
                    print.redLine( "Deploy aborted." );
                    return;
                }
                print.line();
            }
        }

        // Check for wrangler.toml
        var appDir = getCWD();
        if ( !fileExists( appDir & "/wrangler.toml" ) ) {
            print.yellowLine( "Warning: wrangler.toml not found." );
            print.yellowLine( "Make sure your Cloudflare account is configured." );
            print.line();
        }

        // Build wrangler command
        var wranglerArgs = [ "deploy" ];
        if ( arguments.dryRun ) {
            wranglerArgs.append( "--dry-run" );
        }
        if ( arguments.env.len() ) {
            wranglerArgs.append( "--env" );
            wranglerArgs.append( arguments.env );
        }

        // Check if wrangler is available
        var wranglerCmd = "npx";
        if ( fileExists( appDir & "/node_modules/.bin/wrangler" ) ) {
            wranglerCmd = "./node_modules/.bin/wrangler";
        }

        if ( arguments.dryRun ) {
            print.greenLine( "DRY RUN: Would execute:" );
            print.line( "  " & wranglerCmd & " " & wranglerArgs.toList( " " ) );
            print.line();
            print.greenLine( "Run without --dry-run to deploy." );
            return;
        }

        print.greenLine( "Deploying to Cloudflare Workers..." );
        print.line();

        try {
            command( "!" & wranglerCmd )
                .params( wranglerArgs )
                .run();
            print.greenLine( "Deploy complete!" );
        } catch ( any e ) {
            print.redLine( "Deploy failed: " & e.message );
            if ( e.detail.len() ) {
                print.redLine( e.detail );
            }
            print.line();
            print.yellowLine( "Troubleshooting:" );
            print.line( "  1. Ensure you're logged in: npx wrangler login" );
            print.line( "  2. Check wrangler.toml has your account_id" );
            print.line( "  3. Run: npm install" );
        }
    }

}
