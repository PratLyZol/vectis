import type { Metadata } from "next";
import { Trailer } from "@/components/Trailer";

export const metadata: Metadata = { title: "Trailer" };

export default function TrailerPage() {
  return <Trailer />;
}
