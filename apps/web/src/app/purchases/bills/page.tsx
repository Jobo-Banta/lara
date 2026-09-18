import JourneyPage from "../../_components/journey-page";
export default function Page() { return <JourneyPage config={{ eyebrow: "Money out", title: "Bills and payment review", endpoint: "/demo/bills", action: { label: "Correct low-confidence field", url: "/demo/bills/bill-demo-001/correct", body: { correction: "Supplier reference corrected manually" } } }} />; }

