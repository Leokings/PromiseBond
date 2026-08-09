import {
  ArrowRight,
  FileCheck2,
  Landmark,
  LockKeyhole,
  ShieldCheck,
  TimerReset,
  Wallet
} from "lucide-react";
import { PromiseBondHeader } from "./PromiseBondHeader";

export function HowItWorksPage() {
  return (
    <main className="promisebond">
      <PromiseBondHeader currentPage="how-it-works" />

      <div className="pb-frame">
        <section className="pb-hero" aria-labelledby="how-promisebond-title">
          <div className="pb-hero-copy">
            <h1 id="how-promisebond-title" tabIndex={-1}>From public promise to final outcome.</h1>
            <p>
              PromiseBond records measurable terms, locks GEN, and asks GenLayer validators to
              evaluate only the approved public evidence after the deadline.
            </p>
            <div className="pb-hero-actions">
              <a className="pb-button primary" href="/#create-bond">
                Open a bond <ArrowRight aria-hidden="true" size={17} />
              </a>
            </div>
          </div>

          <aside className="pb-boundary-panel" aria-label="PromiseBond execution boundary">
            <div className="pb-panel-heading">
              <div>
                <span>EXECUTION BOUNDARY</span>
                <strong>One GenLayer contract.</strong>
              </div>
              <span className="pb-panel-icon"><Landmark aria-hidden="true" size={24} /></span>
            </div>
            <ol>
              <li>
                <b>01</b>
                <span>The creator funds the exact GEN amount before the funding deadline.</span>
              </li>
              <li>
                <b>02</b>
                <span>The app verifies exactly three independent evidence sources before the contract fixes them with the terms, beneficiary, deadlines, and criteria.</span>
              </li>
              <li>
                <b>03</b>
                <span>After the deadline, validator consensus selects the outcome and contract recipient.</span>
              </li>
            </ol>
            <div className="pb-boundary-foot">
              <LockKeyhole aria-hidden="true" size={15} /> No bridge or external settlement chain
            </div>
          </aside>
        </section>

        <section className="pb-protocol" aria-labelledby="protocol-steps-title">
          <header className="pb-section-heading compact-heading">
            <div>
              <span>THE PROTOCOL</span>
              <h2 id="protocol-steps-title">Three steps. One final Bradbury state.</h2>
            </div>
          </header>
          <div className="pb-protocol-grid">
            <article>
              <span>01</span>
              <Wallet aria-hidden="true" size={22} />
              <h3>Deploy the terms</h3>
              <p>
                The creator deploys the beneficiary wallet, GEN amount, UTC deadlines,
                measurable criteria, and approved public evidence URLs.
              </p>
            </article>
            <article>
              <span>02</span>
              <LockKeyhole aria-hidden="true" size={22} />
              <h3>Fund with GEN</h3>
              <p>
                Before the funding deadline, the creator sends the exact configured amount of
                GEN to the deployed PromiseBond.
              </p>
            </article>
            <article>
              <span>03</span>
              <FileCheck2 aria-hidden="true" size={22} />
              <h3>Resolve and settle</h3>
              <p>
                After the resolution deadline, validators inspect the approved sources. The
                contract then queues the exact locked amount to the selected recipient.
              </p>
            </article>
          </div>
        </section>

        <section className="pb-builder" aria-labelledby="outcomes-title">
          <header className="pb-section-heading compact-heading">
            <div>
              <span>OUTCOMES</span>
              <h2 id="outcomes-title">The result determines who receives the bond.</h2>
            </div>
            <p>The creator bears the risk of unclear evidence and unresolved resolution.</p>
          </header>
          <div className="pb-protocol-grid">
            <article>
              <span>01</span>
              <ShieldCheck aria-hidden="true" size={22} />
              <h3>Fulfilled</h3>
              <p>
                When the approved evidence proves every success criterion by the deadline, the
                locked GEN is queued back to the creator.
              </p>
            </article>
            <article>
              <span>02</span>
              <FileCheck2 aria-hidden="true" size={22} />
              <h3>Failed</h3>
              <p>
                When the approved evidence proves the failure criteria or proves the deadline
                passed without fulfillment, the locked GEN is queued to the beneficiary.
              </p>
            </article>
            <article>
              <span>03</span>
              <TimerReset aria-hidden="true" size={22} />
              <h3>Unresolved or stale</h3>
              <p>
                Unavailable, contradictory, incomplete, or ambiguous evidence is unresolved.
                Time-delayed recovery paths prevent the bond from remaining locked forever.
              </p>
            </article>
          </div>
        </section>

        <section className="pb-bond-feed" aria-labelledby="safety-title">
          <header className="pb-section-heading">
            <div>
              <span>SAFETY FACTS</span>
              <h2 id="safety-title">Know what the app can—and cannot—do.</h2>
            </div>
            <p>Check every term, address, deadline, network, and value in your wallet before signing.</p>
          </header>
          <aside className="pb-boundary-panel" aria-label="PromiseBond safety facts">
            <div className="pb-panel-heading">
              <div>
                <span>SELF-CUSTODIAL USE</span>
                <strong>Your wallet stays in control.</strong>
              </div>
              <span className="pb-panel-icon"><ShieldCheck aria-hidden="true" size={24} /></span>
            </div>
            <ol>
              <li>
                <b>01</b>
                <span>Never enter a seed phrase or private key. PromiseBond only requests wallet signatures.</span>
              </li>
              <li>
                <b>02</b>
                <span>Bradbury contract state is authoritative; the local recovery ledger only helps this device reopen a bond.</span>
              </li>
              <li>
                <b>03</b>
                <span>Evidence URLs are fixed at deployment, and validator consensus—not the website—decides resolution.</span>
              </li>
            </ol>
            <div className="pb-boundary-foot">
              <LockKeyhole aria-hidden="true" size={15} /> Native GEN stays within the PromiseBond contract flow
            </div>
          </aside>
          <div className="pb-hero-actions">
            <a className="pb-button primary" href="/#create-bond">
              Define a PromiseBond <ArrowRight aria-hidden="true" size={17} />
            </a>
          </div>
        </section>

        <footer className="pb-footer">
          <span>PromiseBond</span>
          <span><i /> GENLAYER BRADBURY · 4221</span>
        </footer>
      </div>
    </main>
  );
}
