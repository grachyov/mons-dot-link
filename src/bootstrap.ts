import "./session/pendingLogoutWipeBootstrap";
import { installLogoutSync } from "./session/logoutOrchestrator";
import { getCurrentRouteState } from "./navigation/routeState";
import { startInitialGameBootstrap } from "./services/initialGameBootstrap";

installLogoutSync();
startInitialGameBootstrap(getCurrentRouteState());
void import("./index");
