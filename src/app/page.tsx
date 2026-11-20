import { SplitStrukWorkspace } from "@/components/SplitStrukWorkspace";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string }>;
}) {
  const params = await searchParams;
  return <SplitStrukWorkspace editSlug={params?.edit ?? null} />;
}
