import { redirect } from 'next/navigation';

// The "All Quotes" list page has been removed — redirect to Quote Intake.
export default function Page() {
  redirect('/tools/cs-intake');
}
