import JourneyPage from "../../_components/journey-page";
export default function Page() { return <JourneyPage config={{ eyebrow: "Bank", title: "Reconciliation", endpoint: "/demo/reconciliation", action: { label: "Match bank fee fixture", url: "/demo/reconciliation/bank-line-002/match", body: { amount: 350 } } }} />; }

