import JourneyPage from "../_components/journey-page";
export default function Page() { return <JourneyPage config={{ eyebrow: "Close", title: "Period close", endpoint: "/demo/close", action: { label: "Complete required close task", url: "/demo/close/close-task-001/complete", body: {} } }} />; }

