// Composition by deployment mode: the synthetic prototype renders only on the
// demo host; every other mode renders the production workspace over /v1.
// The demo adapter is never reachable from a production composition.
import DemoWorkspace from './demo-workspace';
import Workspace from './workspace';
export default function Composition(){return process.env.LARA_MODE==='demo'?<DemoWorkspace/>:<Workspace/>;}
