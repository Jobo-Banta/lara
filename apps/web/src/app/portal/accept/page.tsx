import {PortalAccept} from "../../_components/workspace-portal";
// The invited identity has no membership until the token is accepted, so this page lives outside the workspace shell.
export const dynamic='force-dynamic';
export default function Page(){return <PortalAccept/>;}
