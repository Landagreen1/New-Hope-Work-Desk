import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms & Conditions | New Hope Insurance",
  description:
    "Terms and conditions governing use of New Hope Insurance services and communications.",
};

export default function TermsPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <header className="mb-12">
        <Link
          href="/"
          className="inline-block text-sm font-bold text-[#223f7a] hover:underline"
        >
          &larr; Back to New Hope Work Desk
        </Link>
        <h1 className="mt-6 text-3xl font-black text-slate-950">
          Terms &amp; Conditions
        </h1>
        <p className="mt-2 text-sm font-semibold text-slate-500">
          Last updated: July 20, 2025
        </p>
      </header>

      <article className="prose prose-slate max-w-none space-y-8 text-sm leading-7 text-slate-700">
        <section>
          <h2 className="text-lg font-black text-slate-900">
            1. Agreement to Terms
          </h2>
          <p>
            By accessing or using services provided by New Hope Insurance Group
            (&ldquo;New Hope,&rdquo; &ldquo;we,&rdquo; &ldquo;us,&rdquo; or
            &ldquo;our&rdquo;), including but not limited to our website,
            internal platforms, and communications, you agree to be bound by
            these Terms &amp; Conditions. If you do not agree to these terms,
            please do not use our services.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-black text-slate-900">
            2. Services Description
          </h2>
          <p>
            New Hope Insurance Group provides insurance brokerage, policy
            management, renewal assistance, and related customer support
            services. We connect clients with appropriate insurance carriers and
            assist with policy selection, quoting, binding, and ongoing service
            throughout the policy lifecycle.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-black text-slate-900">
            3. SMS/Text Messaging Terms
          </h2>
          <p>
            By providing your phone number to New Hope Insurance Group, you
            consent to receive service-related text messages including but not
            limited to:
          </p>
          <ul className="ml-5 list-disc space-y-1">
            <li>Policy renewal reminders and notifications</li>
            <li>Appointment confirmations and updates</li>
            <li>Payment and billing reminders</li>
            <li>Policy status updates</li>
            <li>Responses to your inquiries</li>
          </ul>
          <p className="mt-4">
            <strong>Message frequency:</strong> Message frequency varies based
            on your policy schedule and interactions with our office. You may
            receive up to 10 messages per month related to your account.
          </p>
          <p>
            <strong>Message and data rates:</strong> Standard message and data
            rates may apply depending on your mobile carrier and plan.
          </p>
          <p>
            <strong>Opt-out:</strong> You may opt out of text messages at any
            time by replying <strong>STOP</strong> to any message you receive
            from us. After opting out, you will receive a single confirmation
            message and no further texts will be sent unless you re-subscribe.
          </p>
          <p>
            <strong>Help:</strong> For assistance, reply <strong>HELP</strong>{" "}
            to any message or contact our office directly at your designated
            agency phone number.
          </p>
          <p>
            <strong>Opt-in:</strong> Consent to receive text messages is not a
            condition of purchasing insurance or receiving service from New Hope
            Insurance Group. You may opt in by providing your mobile number
            during policy onboarding, verbally during a call with our team, or
            by texting START to our business number.
          </p>
          <p>
            <strong>Supported carriers:</strong> Compatible with all major US
            carriers including AT&amp;T, T-Mobile, Verizon, Sprint, and others.
            Carriers are not liable for delayed or undelivered messages.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-black text-slate-900">
            4. User Responsibilities
          </h2>
          <p>You agree to:</p>
          <ul className="ml-5 list-disc space-y-1">
            <li>
              Provide accurate and current information when interacting with our
              services
            </li>
            <li>
              Notify us promptly of any changes to your contact information
            </li>
            <li>
              Not use our services for any unlawful or unauthorized purpose
            </li>
            <li>
              Not attempt to gain unauthorized access to our systems or platforms
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-black text-slate-900">
            5. Intellectual Property
          </h2>
          <p>
            All content, trademarks, logos, and materials available through our
            services are owned by or licensed to New Hope Insurance Group and are
            protected by applicable intellectual property laws. You may not
            reproduce, distribute, or create derivative works from our materials
            without prior written consent.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-black text-slate-900">
            6. Limitation of Liability
          </h2>
          <p>
            New Hope Insurance Group provides brokerage and advisory services.
            We do not underwrite insurance policies and are not liable for
            coverage decisions made by insurance carriers. To the maximum extent
            permitted by law, New Hope Insurance Group shall not be liable for
            any indirect, incidental, special, consequential, or punitive
            damages arising from your use of or inability to use our services.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-black text-slate-900">
            7. Disclaimer of Warranties
          </h2>
          <p>
            Our services are provided on an &ldquo;as is&rdquo; and &ldquo;as
            available&rdquo; basis. We make no warranties, express or implied,
            regarding the accuracy, completeness, or reliability of any
            information or service provided through our platforms.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-black text-slate-900">
            8. Third-Party Services
          </h2>
          <p>
            Our services may integrate with or reference third-party services
            including insurance carriers, payment processors, and communication
            platforms. We are not responsible for the practices, policies, or
            content of any third-party services. Your use of third-party
            services is governed by their respective terms.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-black text-slate-900">
            9. Modifications to Terms
          </h2>
          <p>
            We reserve the right to modify these Terms &amp; Conditions at any
            time. Material changes will be communicated through our website or
            direct notification. Continued use of our services after changes are
            posted constitutes acceptance of the revised terms.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-black text-slate-900">
            10. Governing Law
          </h2>
          <p>
            These Terms &amp; Conditions are governed by and construed in
            accordance with the laws of the State of North Carolina, without
            regard to its conflict of law provisions.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-black text-slate-900">
            11. Contact Information
          </h2>
          <p>
            If you have questions about these Terms &amp; Conditions, please
            contact us:
          </p>
          <address className="mt-2 not-italic">
            <strong>New Hope Insurance Group</strong>
            <br />
            Email: info@newhopeinsg.com
            <br />
            Website: www.newhopeinsg.com
          </address>
        </section>
      </article>

      <footer className="mt-16 border-t border-slate-200 pt-8 text-xs font-semibold text-slate-400">
        <div className="flex gap-4">
          <Link href="/privacy" className="hover:text-[#223f7a] hover:underline">
            Privacy Policy
          </Link>
          <Link href="/terms" className="hover:text-[#223f7a] hover:underline">
            Terms &amp; Conditions
          </Link>
        </div>
        <p className="mt-3">
          &copy; {new Date().getFullYear()} New Hope Insurance Group. All rights
          reserved.
        </p>
      </footer>
    </main>
  );
}
