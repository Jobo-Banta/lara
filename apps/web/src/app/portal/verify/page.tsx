import {PortalVerify} from "../../_components/workspace-portal";
// A share link's recipient holds no session, so verification lives outside the workspace shell.
export const dynamic='force-dynamic';
export default function Page(){return <PortalVerify/>;}
