import Composition from "../../_components/composition";
// Rendered per request so the deployment mode, not the build machine, selects the composition.
export const dynamic='force-dynamic';
export default function Page(){return <Composition/>;}
