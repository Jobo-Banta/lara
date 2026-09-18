import "@lara/ui/theme.css";

export const metadata = {
  title: "LARA",
  description: "Ledger and reporting workspace",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
