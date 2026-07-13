import type { SourceClassification } from "@omni/shared";
import type { ClassifiedSource, RetrievedPage } from "./crawler-types.js";
import { domainOf } from "./url-normalizer.js";

/**
 * Transparent, heuristic source classification and quality scoring.
 * The score is a heuristic aid, not objective truth — every adjustment is
 * recorded in `reasons` and shown to the user.
 */

const GOV_TLDS = [".gov", ".mil", ".gov.uk", ".gc.ca", ".gov.au", ".gov.in", ".europa.eu", ".gov.np"];
const EDU_TLDS = [".edu", ".ac.uk", ".edu.au", ".ac.in", ".ac.jp", ".edu.np"];
const PEER_REVIEWED_HOSTS = [
  "doi.org",
  "pubmed.ncbi.nlm.nih.gov",
  "ncbi.nlm.nih.gov",
  "arxiv.org",
  "nature.com",
  "science.org",
  "sciencedirect.com",
  "springer.com",
  "link.springer.com",
  "wiley.com",
  "onlinelibrary.wiley.com",
  "tandfonline.com",
  "cambridge.org",
  "oup.com",
  "academic.oup.com",
  "plos.org",
  "journals.plos.org",
  "ieee.org",
  "ieeexplore.ieee.org",
  "acm.org",
  "dl.acm.org",
  "jstor.org",
];
const REFERENCE_HOSTS = [
  "wikipedia.org",
  "britannica.com",
  "khanacademy.org",
  "ocw.mit.edu",
  "openstax.org",
  "developer.mozilla.org",
  "docs.python.org",
  "w3.org",
];
const USER_GENERATED_HOSTS = [
  "reddit.com",
  "quora.com",
  "stackexchange.com",
  "stackoverflow.com",
  "medium.com",
  "substack.com",
  "x.com",
  "twitter.com",
  "facebook.com",
  "tiktok.com",
  "youtube.com",
];

function hostMatches(domain: string, hosts: string[]): boolean {
  return hosts.some((h) => domain === h || domain.endsWith(`.${h}`));
}

export function classifySource(page: RetrievedPage): ClassifiedSource {
  const domain = domainOf(page.finalUrl);
  const reasons: string[] = [];
  let classification: SourceClassification = "unknown";
  let score = 50;

  if (GOV_TLDS.some((tld) => domain.endsWith(tld))) {
    classification = "government";
    score += 20;
    reasons.push(`government domain (${domain}): +20`);
  } else if (hostMatches(domain, PEER_REVIEWED_HOSTS)) {
    classification = "peer-reviewed";
    score += 25;
    reasons.push(`known scholarly publisher (${domain}): +25`);
  } else if (EDU_TLDS.some((tld) => domain.endsWith(tld))) {
    classification = "academic";
    score += 15;
    reasons.push(`academic domain (${domain}): +15`);
  } else if (hostMatches(domain, REFERENCE_HOSTS)) {
    classification = "educational-reference";
    score += 10;
    reasons.push(`established educational reference (${domain}): +10`);
  } else if (hostMatches(domain, USER_GENERATED_HOSTS)) {
    classification = "user-generated";
    score -= 15;
    reasons.push(`user-generated content platform (${domain}): -15`);
  } else if (page.metadata.publisher && page.metadata.publishedAt && page.metadata.author) {
    classification = "journalism";
    reasons.push("named author, publisher, and publication date present: treated as journalism");
  }

  if (page.metadata.isOpinionSection) {
    classification = classification === "journalism" ? "opinion" : classification;
    score -= 10;
    reasons.push("opinion/editorial indicators: -10");
  }

  if (page.metadata.author) {
    score += 5;
    reasons.push("identified author: +5");
  } else {
    reasons.push("author unavailable: no adjustment, flagged in citation");
  }
  if (page.metadata.publishedAt) {
    score += 5;
    reasons.push("publication date present: +5");
  } else {
    score -= 5;
    reasons.push("publication date unavailable: -5");
  }
  if (page.metadata.publisher) {
    score += 3;
    reasons.push("identified publisher: +3");
  }

  const referenceish = page.outboundLinks.filter((l) => domainOf(l.url) !== domain).length;
  if (referenceish >= 5) {
    score += 4;
    reasons.push(`cites ${referenceish} external links: +4`);
  }

  if (page.wordCount < 150) {
    score -= 10;
    reasons.push("very short content (<150 words): -10");
  } else if (page.wordCount > 800) {
    score += 3;
    reasons.push("substantial content (>800 words): +3");
  }

  if (page.paywallSuspected) {
    score -= 8;
    reasons.push("possible paywall truncation: -8");
  }

  score = Math.max(0, Math.min(100, score));
  return { classification, qualityScore: score, reasons };
}
