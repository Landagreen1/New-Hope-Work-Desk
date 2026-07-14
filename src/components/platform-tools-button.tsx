import Link from 'next/link';
import { BriefcaseBusiness } from 'lucide-react';

export function PlatformToolsButton() {
  return (
    <Link
      href="/tools"
      className="fixed bottom-5 right-5 z-40 inline-flex items-center gap-2 rounded-2xl bg-[#223f7a] px-4 py-3 text-sm font-black text-white shadow-xl transition hover:-translate-y-0.5 hover:bg-[#17305f]"
    >
      <BriefcaseBusiness className="h-4 w-4" />Operations Tools
    </Link>
  );
}
