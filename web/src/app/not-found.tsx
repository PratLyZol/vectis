import Link from "next/link";

export default function NotFound() {
  return (
    <div className="card max-w-[560px] p-6">
      <h1 className="text-[24px]">Page not found</h1>
      <p className="mt-2 text-muted">
        This address does not match a page or an active Gemini market. The market may have closed.
      </p>
      <Link href="/markets" className="btn btn-primary mt-5">
        See all markets
      </Link>
    </div>
  );
}
