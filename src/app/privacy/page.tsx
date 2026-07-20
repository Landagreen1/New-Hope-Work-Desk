import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy | New Hope Insurance",
  description:
    "Privacy policy describing how New Hope Insurance Group collects, uses, and protects your personal information.",
};

export default function PrivacyPage() {
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
          Privacy Policy
        </h1>
        <p className="mt-2 text-sm font-semibold text-slate-500">
          Last updated: July 20, 2025
        </p>
      </header>

      <article className="prose prose-slate max-w-none space-y-8 text-sm leading-7 text-slate-700">
        <section>
          <h2 className="text-lg font-black text-slate-900">1. Introduction</h2>
          <p>
            New Hope Insurance Group (&ldquo;New Hope,&rdquo; &ldquo;we,&rdquo;
            &ldquo;us,&rdquo; or &ldquo;our&rdquo;) is committed to protecting
            your privacy. This Privacy Policy explains how we collect, use,
            disclose, and safeguard your personal information when you interact
            with our services, including our website, internal platforms, and
            communications channels such as phone, email, and text messaging.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-black text-slate-900">
            2. Information We Collect
          </h2>
          <h3 className="text-base font-bold text-slate-800">
            2.1 Information You Provide
          </h3>
          <ul className="ml-5 list-disc space-y-1">
            <li>
              <strong>Contact information:</strong> Name, phone number, email
              address, mailing address
            </li>
            <li>
              <strong>Policy information:</strong> Policy numbers, carrier
              names, coverage types, renewal dates, premium amounts
            </li>
            <li>
              <strong>Identity information:</strong> Date of birth,
              driver&apos;s license number (state and last four digits retained
              for verification), vehicle information
            </li>
            <li>
              <strong>Financial information:</strong> Payment method details for
              premium processing (processed securely through carrier or
              third-party payment systems)
            </li>
            <li>
              <strong>Communication records:</strong> Notes from phone calls,
              text message history, email correspondence related to your
              policies
            </li>
          </ul>

          <h3 className="mt-4 text-base font-bold text-slate-800">
            2.2 Information Collected Automatically
          </h3>
          <ul className="ml-5 list-disc space-y-1">
            <li>
              Device and browser information when accessing our online platforms
            </li>
            <li>IP address and general location data</li>
            <li>Usage data related to our internal service platforms</li>
          </ul>

          <h3 className="mt-4 text-base font-bold text-slate-800">
            2.3 Information from Third Parties
          </h3>
          <ul className="ml-5 list-disc space-y-1">
            <li>
              Agency management system records (e.g., HawkSoft) containing
              policy, client, and renewal data
            </li>
            <li>
              Insurance carrier information regarding policy status, claims, and
              renewals
            </li>
            <li>
              Public records used for identity verification and quoting purposes
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-black text-slate-900">
            3. How We Use Your Information
          </h2>
          <p>We use the information we collect to:</p>
          <ul className="ml-5 list-disc space-y-1">
            <li>
              Provide insurance brokerage services including quoting, binding,
              and servicing policies
            </li>
            <li>
              Send policy renewal reminders and service notifications via text
              message, email, or phone
            </li>
            <li>
              Process payments and manage billing on behalf of insurance carriers
            </li>
            <li>Respond to your inquiries and provide customer support</li>
            <li>
              Maintain accurate records of your insurance history and
              interactions with our office
            </li>
            <li>
              Comply with legal and regulatory requirements applicable to
              insurance operations
            </li>
            <li>
              Improve our services, platforms, and internal operational processes
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-black text-slate-900">
            4. SMS/Text Message Privacy
          </h2>
          <p>
            When you provide your mobile phone number and consent to receive
            text messages from New Hope Insurance Group:
          </p>
          <ul className="ml-5 list-disc space-y-1">
            <li>
              Your phone number is stored securely in our systems and is used
              solely for service-related communications
            </li>
            <li>
              <strong>
                We do not sell, rent, or share your phone number with third
                parties for marketing purposes
              </strong>
            </li>
            <li>
              <strong>
                We do not share your opt-in data or consent status with any
                third party other than our messaging service provider for the
                purpose of delivering messages
              </strong>
            </li>
            <li>
              Message content may include your name, policy number, carrier
              name, and renewal date for identification purposes
            </li>
            <li>
              Text message records are retained as part of your customer service
              history
            </li>
            <li>
              You may opt out at any time by replying <strong>STOP</strong> to
              any message
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-black text-slate-900">
            5. Information Sharing and Disclosure
          </h2>
          <p>
            We may share your personal information in the following
            circumstances:
          </p>
          <ul className="ml-5 list-disc space-y-1">
            <li>
              <strong>Insurance carriers:</strong> To obtain quotes, bind
              policies, process claims, and service your account
            </li>
            <li>
              <strong>Service providers:</strong> Third-party vendors who assist
              with our operations (e.g., communication platforms, payment
              processors, agency management systems) under contractual
              obligations to protect your data
            </li>
            <li>
              <strong>Legal requirements:</strong> When required by law,
              subpoena, court order, or regulatory authority
            </li>
            <li>
              <strong>Business transfers:</strong> In connection with a merger,
              acquisition, or sale of assets, your information may be
              transferred as part of that transaction
            </li>
          </ul>
          <p className="mt-4">
            <strong>
              We do not sell your personal information to third parties.
            </strong>
          </p>
        </section>

        <section>
          <h2 className="text-lg font-black text-slate-900">
            6. Data Security
          </h2>
          <p>
            We implement appropriate technical and organizational measures to
            protect your personal information, including:
          </p>
          <ul className="ml-5 list-disc space-y-1">
            <li>Encryption of data in transit and at rest</li>
            <li>
              Role-based access controls limiting data access to authorized
              personnel
            </li>
            <li>
              Secure storage of sensitive identifiers (driver&apos;s license
              numbers are hashed; only the issuing state and last four
              characters are retained in standard access systems)
            </li>
            <li>Regular security reviews of our platforms and processes</li>
            <li>
              Audit logging of access to sensitive customer information
            </li>
          </ul>
          <p className="mt-4">
            While we strive to protect your personal information, no method of
            transmission over the internet or electronic storage is completely
            secure. We cannot guarantee absolute security.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-black text-slate-900">
            7. Data Retention
          </h2>
          <p>
            We retain your personal information for as long as necessary to
            fulfill the purposes described in this policy, maintain your
            account, comply with legal obligations, resolve disputes, and
            enforce our agreements. Insurance records are generally retained for
            a minimum of seven years after policy expiration in accordance with
            industry standards and regulatory requirements.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-black text-slate-900">
            8. Your Rights and Choices
          </h2>
          <p>You have the right to:</p>
          <ul className="ml-5 list-disc space-y-1">
            <li>
              <strong>Access:</strong> Request a copy of the personal
              information we hold about you
            </li>
            <li>
              <strong>Correction:</strong> Request that we correct inaccurate or
              incomplete personal information
            </li>
            <li>
              <strong>Opt-out of texts:</strong> Reply STOP to any text message
              to unsubscribe from SMS communications
            </li>
            <li>
              <strong>Communication preferences:</strong> Contact us to update
              your preferred communication methods
            </li>
            <li>
              <strong>Deletion:</strong> Request deletion of your personal
              information, subject to legal and regulatory retention
              requirements
            </li>
          </ul>
          <p className="mt-4">
            To exercise any of these rights, please contact us using the
            information provided below.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-black text-slate-900">
            9. Children&apos;s Privacy
          </h2>
          <p>
            Our services are not directed to individuals under the age of 18. We
            do not knowingly collect personal information from children. If we
            become aware that a child has provided us with personal information,
            we will take steps to delete such information.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-black text-slate-900">
            10. Changes to This Policy
          </h2>
          <p>
            We may update this Privacy Policy from time to time. When we make
            material changes, we will update the &ldquo;Last updated&rdquo; date
            at the top of this page and, where appropriate, notify you through
            our services or direct communication.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-black text-slate-900">
            11. Contact Us
          </h2>
          <p>
            If you have questions or concerns about this Privacy Policy or our
            data practices, please contact us:
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
