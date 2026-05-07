/**
 *  SkyBox CLI — CommandBox Module Configuration
 *
 *  This module provides CLI tooling for developing and deploying
 *  SkyBox (MatchBox CF Worker) applications — BoxLang WebSocket
 *  apps running on Cloudflare Workers via WASM.
 *
 *  Commands:
 *    - box skybox init     Scaffold a new SkyBox project
 *    - box skybox build    Build .bx sources into WASM worker
 *    - box skybox dev      Start local dev server (wrangler)
 *    - box skybox deploy   Deploy to Cloudflare Workers
 *    - box skybox new      Scaffold a demo app from templates
 *
 *  @author  SkyBox Contributors
 *  @version 1.0.0
 */
component {

    this.name      = "SkyBox CLI";
    this.version   = "1.0.0";
    this.cfmapping = "skybox-cli";

    /**
     * Module configuration — sets template path relative to module root
     */
    function configure() {
        variables.settings = {
            templatesPath : modulePath & "/templates"
        };
    }

    /**
     * Called after the module is fully loaded
     */
    function onLoad() {
        log.info( "SkyBox CLI loaded successfully." );
    }

    /**
     * Called when the module is unloaded
     */
    function onUnLoad() {
        log.info( "SkyBox CLI unloaded." );
    }

}
