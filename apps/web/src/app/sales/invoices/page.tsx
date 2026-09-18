import JourneyPage from "../../_components/journey-page";
export default function Page() { return <JourneyPage config={{ eyebrow: "Money in", title: "Sales invoices", endpoint: "/demo/invoices", action: { label: "Create demo invoice", url: "/demo/invoices", body: { customer: "New demo customer", subtotal: 10000, idempotencyKey: "new-demo-invoice" } } }} />; }

