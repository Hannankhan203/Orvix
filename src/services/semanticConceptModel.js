/**
 * Orvix Client-Side Semantic Concept Ontology & Lexical Field Model
 * Provides zero-download, 100% offline conceptual representation mapping words, stems,
 * and key phrases into semantic synsets, conceptual clusters, and domain fields.
 *
 * Enables genuine semantic similarity for synonyms, paraphrases, and alternate vocabularies
 * (e.g. physician <-> doctor, cash <-> reimbursement, firm profit <-> net revenue)
 * without requiring multi-hundred-megabyte network model downloads or neural weights.
 */

// Broad conceptual cluster definitions
const RAW_CONCEPT_GROUPS = [
  // 1. Finance, Currency, Gains & Economics
  {
    cluster: 'FINANCE_MONEY_CURRENCY',
    domain: 'FINANCE',
    words: [
      'money', 'cash', 'funds', 'fund', 'currency', 'dollar', 'dollars', 'capital', 'financing',
      'assets', 'balance', 'wealth', 'proceeds', 'liquidity', 'coin', 'coins', 'cashflow'
    ]
  },
  {
    cluster: 'FINANCE_EARNINGS_PROFIT',
    domain: 'FINANCE',
    words: [
      'profit', 'profits', 'profitable', 'profitability', 'revenue', 'revenues', 'earning', 'earnings',
      'income', 'net', 'gross', 'turnover', 'margin', 'margins', 'gain', 'gains', 'ebitda',
      'yield', 'receipts', 'surplus', 'dividend', 'dividends', 'financial', 'finance',
      'make', 'making', 'made', 'earn', 'earned', 'generate', 'generating', 'generated', 'produce'
    ]
  },
  {
    cluster: 'FINANCE_COST_EXPENSE',
    domain: 'FINANCE',
    words: [
      'cost', 'costs', 'expense', 'expenses', 'expenditure', 'fee', 'fees', 'price', 'prices',
      'pricing', 'charge', 'charges', 'spending', 'spend', 'bill', 'billing', 'invoice', 'invoices',
      'payable', 'rate', 'rates', 'tariff', 'levy', 'outlay', 'overhead', 'disbursement'
    ]
  },
  {
    cluster: 'FINANCE_REFUND_REIMBURSEMENT',
    domain: 'FINANCE',
    words: [
      'refund', 'refunds', 'refundable', 'reimbursement', 'reimbursements', 'reimburse', 'reimbursed',
      'rebate', 'rebates', 'return', 'returns', 'cashback', 'cash back', 'repayment', 'repay', 'moneyback',
      'money back', 'indemnity', 'remuneration', 'allowance', 'credit'
    ]
  },
  {
    cluster: 'COMMERCE_PURCHASE_BUY',
    domain: 'COMMERCE',
    words: [
      'buy', 'buying', 'bought', 'purchase', 'purchases', 'purchasing', 'purchased', 'acquire',
      'acquiring', 'acquisition', 'procure', 'procurement', 'order', 'orders', 'ordering', 'ordered',
      'shop', 'shopping', 'checkout', 'transaction', 'transactions'
    ]
  },
  {
    cluster: 'COMMERCE_CLIENT_CUSTOMER',
    domain: 'COMMERCE',
    words: [
      'customer', 'customers', 'client', 'clients', 'patron', 'patrons', 'buyer', 'buyers',
      'consumer', 'consumers', 'shopper', 'shoppers', 'subscriber', 'subscribers', 'purchaser',
      'user', 'users', 'account', 'accounts', 'guest', 'guests'
    ]
  },

  // 2. Customer Support, Assistance & Help
  {
    cluster: 'SUPPORT_ASSISTANCE_HELP',
    domain: 'CUSTOMER_SERVICE',
    words: [
      'support', 'supporting', 'assistance', 'assist', 'assisting', 'help', 'helping', 'helper',
      'helpdesk', 'help desk', 'customer support', 'customer service', 'service', 'servicing',
      'hotline', 'representative', 'representatives', 'rep', 'agent', 'agents', 'technician',
      'specialist', 'care', 'guidance', 'advisory', 'consultant', 'team', 'staff', 'desk'
    ]
  },
  {
    cluster: 'INQUIRY_QUESTION_ISSUE',
    domain: 'CUSTOMER_SERVICE',
    words: [
      'inquiry', 'inquiries', 'question', 'questions', 'query', 'queries', 'ask', 'asking',
      'complaint', 'complaints', 'ticket', 'tickets', 'issue', 'issues', 'dispute', 'disputes',
      'problem', 'problems', 'trouble', 'troubleshooting', 'grievance', 'bug', 'bugs', 'defect',
      'glitch', 'error', 'errors', 'failure', 'fail', 'flaw', 'breakage'
    ]
  },
  {
    cluster: 'RESOLUTION_SOLVE_FIX',
    domain: 'CUSTOMER_SERVICE',
    words: [
      'solve', 'solving', 'solution', 'solutions', 'resolve', 'resolving', 'resolution', 'resolutions',
      'fix', 'fixing', 'fixed', 'repair', 'repairing', 'rectify', 'patch', 'patching', 'workaround',
      'remedy', 'remedying', 'cure', 'correct', 'correction', 'satisfaction'
    ]
  },
  {
    cluster: 'COMMUNICATION_CONTACT_REACH',
    domain: 'CUSTOMER_SERVICE',
    words: [
      'contact', 'contacting', 'reach', 'reaching', 'touch', 'call', 'calling', 'phone', 'telephone',
      'email', 'emailing', 'chat', 'chatting', 'message', 'messaging', 'inbox', 'talk', 'speak',
      'notify', 'notification', 'alert', 'communicate', 'communication'
    ]
  },

  // 3. Healthcare, Medicine, Clinical & Doctors
  {
    cluster: 'HEALTH_DOCTOR_PHYSICIAN',
    domain: 'HEALTHCARE',
    words: [
      'doctor', 'doctors', 'physician', 'physicians', 'clinician', 'clinicians', 'specialist',
      'specialists', 'surgeon', 'surgeons', 'practitioner', 'practitioners', 'medic', 'medics',
      'nurse', 'nurses', 'provider', 'providers', 'caregiver', 'caregivers', 'therapist', 'therapists'
    ]
  },
  {
    cluster: 'HEALTH_MEDICINE_PHARMACY',
    domain: 'HEALTHCARE',
    words: [
      'medicine', 'medicines', 'medication', 'medications', 'pharmaceutical', 'pharmaceuticals',
      'pharmacy', 'drug', 'drugs', 'pill', 'pills', 'tablet', 'tablets', 'capsule', 'capsules',
      'prescription', 'prescriptions', 'prescribe', 'prescribed', 'prescribing', 'dose', 'dosage',
      'remedy', 'remedies', 'antibiotic', 'antibiotics', 'treatment', 'treatments', 'therapy'
    ]
  },
  {
    cluster: 'HEALTH_PATIENT_SICKNESS',
    domain: 'HEALTHCARE',
    words: [
      'patient', 'patients', 'sick', 'sickness', 'ill', 'illness', 'disease', 'diseases', 'condition',
      'disorder', 'infection', 'infections', 'ailment', 'ailments', 'symptom', 'symptoms', 'syndrome',
      'pain', 'ache', 'fever', 'cough', 'injury', 'wound', 'diagnose', 'diagnosis', 'diagnostic',
      'clinic', 'hospital', 'ward', 'infirmary', 'recovery', 'health', 'wellness'
    ]
  },

  // 4. Legal, Terms, Contracts, Rights & Policies
  {
    cluster: 'LEGAL_CONTRACT_AGREEMENT',
    domain: 'LEGAL',
    words: [
      'contract', 'contracts', 'agreement', 'agreements', 'deal', 'deals', 'pact', 'accord',
      'covenant', 'treaty', 'clause', 'clauses', 'provision', 'provisions', 'section', 'sections',
      'stipulation', 'terms', 'conditions', 'term', 'document', 'understanding'
    ]
  },
  {
    cluster: 'LEGAL_POLICY_RULE_LAW',
    domain: 'LEGAL',
    words: [
      'policy', 'policies', 'rule', 'rules', 'regulation', 'regulations', 'regulatory', 'statute',
      'statutes', 'law', 'laws', 'legal', 'lawful', 'compliance', 'compliant', 'standard', 'standards',
      'guideline', 'guidelines', 'protocol', 'protocols', 'mandate', 'mandates', 'code'
    ]
  },
  {
    cluster: 'LEGAL_RIGHT_ELIGIBILITY_WARRANTY',
    domain: 'LEGAL',
    words: [
      'right', 'rights', 'entitled', 'entitlement', 'eligible', 'eligibility', 'privilege',
      'privileges', 'warranty', 'warranties', 'guarantee', 'guarantees', 'guaranteed', 'assurance',
      'permission', 'permit', 'license', 'licenses', 'authorized', 'authorization', 'consent'
    ]
  },
  {
    cluster: 'LEGAL_TERMINATION_CANCEL',
    domain: 'LEGAL',
    words: [
      'cancel', 'cancelling', 'canceled', 'cancelled', 'cancellation', 'cancellations', 'terminate',
      'terminating', 'terminated', 'termination', 'terminations', 'end', 'ending', 'discontinue',
      'discontinuation', 'revoke', 'revoking', 'revocation', 'rescind', 'rescission', 'abort',
      'expire', 'expiration', 'void', 'nullify', 'stop', 'stopping'
    ]
  },
  {
    cluster: 'SUBSCRIPTION_MEMBERSHIP_PLAN',
    domain: 'COMMERCE',
    words: [
      'subscription', 'subscriptions', 'membership', 'memberships', 'plan', 'plans', 'tier',
      'tiers', 'recurring', 'renewal', 'renew', 'package', 'enrollment', 'subscribed'
    ]
  },

  // 5. Business, Company, Organization & HR
  {
    cluster: 'BUSINESS_COMPANY_ENTITY',
    domain: 'BUSINESS',
    words: [
      'company', 'companies', 'firm', 'firms', 'enterprise', 'enterprises', 'corporation',
      'corporations', 'corp', 'business', 'businesses', 'organization', 'organizations', 'agency',
      'agencies', 'institution', 'entity', 'venture', 'startup', 'startups', 'group', 'conglomerate'
    ]
  },
  {
    cluster: 'HR_EMPLOYEE_WORKFORCE',
    domain: 'BUSINESS',
    words: [
      'employee', 'employees', 'worker', 'workers', 'staff', 'personnel', 'workforce', 'teammate',
      'teammates', 'labor', 'crew', 'hire', 'hiring', 'hired', 'recruit', 'recruiting', 'onboard',
      'job', 'jobs', 'career', 'role', 'roles', 'position', 'positions', 'occupation', 'employment'
    ]
  },
  {
    cluster: 'HR_COMPENSATION_SALARY',
    domain: 'BUSINESS',
    words: [
      'salary', 'salaries', 'wage', 'wages', 'pay', 'paying', 'payroll', 'compensation', 'perk',
      'perks', 'benefit', 'benefits', 'bonus', 'bonuses', 'stipend', 'incentive', 'remuneration',
      'vacation', 'leave', 'pto', 'holiday'
    ]
  },

  // 6. Technology, Software, Systems & Security
  {
    cluster: 'TECH_SOFTWARE_APP',
    domain: 'TECHNOLOGY',
    words: [
      'software', 'application', 'applications', 'app', 'apps', 'program', 'programs', 'platform',
      'platforms', 'system', 'systems', 'code', 'codebase', 'script', 'scripts', 'binary', 'binaries',
      'tool', 'tools', 'utility', 'library', 'framework', 'module', 'component', 'package'
    ]
  },
  {
    cluster: 'TECH_DATABASE_DATA',
    domain: 'TECHNOLOGY',
    words: [
      'database', 'databases', 'datastore', 'storage', 'dataset', 'datasets', 'table', 'tables',
      'record', 'records', 'row', 'rows', 'document', 'documents', 'collection', 'index', 'indexing',
      'query', 'queries', 'schema', 'repository', 'data', 'store'
    ]
  },
  {
    cluster: 'TECH_SECURITY_AUTH',
    domain: 'TECHNOLOGY',
    words: [
      'security', 'secure', 'authentication', 'auth', 'login', 'signin', 'credential', 'credentials',
      'password', 'passwords', 'token', 'tokens', 'secret', 'key', 'keys', 'encryption', 'encrypted',
      'decrypt', 'protection', 'protect', 'vulnerability', 'permission', 'privacy', 'confidential'
    ]
  },

  // 7. Quantitative Changes & Directions
  {
    cluster: 'METRIC_INCREASE_GROWTH',
    domain: 'METRICS',
    words: [
      'increase', 'increases', 'increasing', 'increased', 'growth', 'grow', 'growing', 'grew',
      'rise', 'rising', 'rose', 'climb', 'climbing', 'boost', 'boosting', 'boosted', 'surge',
      'surging', 'expand', 'expanding', 'expansion', 'uptick', 'gain', 'jump', 'double', 'triple'
    ]
  },
  {
    cluster: 'METRIC_DECREASE_DECLINE',
    domain: 'METRICS',
    words: [
      'decrease', 'decreases', 'decreasing', 'decreased', 'decline', 'declining', 'declined',
      'drop', 'dropping', 'dropped', 'fall', 'falling', 'fell', 'reduction', 'reducing', 'reduced',
      'shrink', 'shrinking', 'plunge', 'cut', 'cuts', 'loss', 'losses', 'deficit', 'downward'
    ]
  },

  // 8. Travel, Transportation & Logistics
  {
    cluster: 'TRAVEL_TRANSPORT_JOURNEY',
    domain: 'TRAVEL',
    words: [
      'travel', 'traveling', 'trip', 'trips', 'journey', 'journeys', 'voyage', 'transit', 'flight',
      'flights', 'plane', 'airline', 'airport', 'train', 'rail', 'railway', 'bus', 'vehicle', 'car',
      'automobile', 'hotel', 'lodging', 'accommodation', 'reservation', 'booking', 'itinerary',
      'destination', 'arrival', 'departure', 'luggage', 'baggage', 'shipment', 'delivery', 'shipping'
    ]
  }
];

// Inverted lookup map: word or phrase -> Array<{ cluster: string, domain: string }>
const WORD_TO_CONCEPTS = new Map();

for (const group of RAW_CONCEPT_GROUPS) {
  const { cluster, domain, words } = group;
  for (const word of words) {
    const lower = word.toLowerCase().trim();
    if (!WORD_TO_CONCEPTS.has(lower)) {
      WORD_TO_CONCEPTS.set(lower, []);
    }
    WORD_TO_CONCEPTS.get(lower).push({ cluster, domain });
  }
}

/**
 * Retrieves semantic concept clusters and domain tags for a given token or stem.
 *
 * @param {string} word - Original lowercase word
 * @param {string} [stem] - Morphologically stemmed form
 * @returns {Array<{ cluster: string, domain: string }>}
 */
export function getConceptsForWord(word, stem = null) {
  if (!word || typeof word !== 'string') return [];

  const results = [];
  const seenClusters = new Set();

  const primary = WORD_TO_CONCEPTS.get(word);
  if (primary) {
    for (const item of primary) {
      if (!seenClusters.has(item.cluster)) {
        seenClusters.add(item.cluster);
        results.push(item);
      }
    }
  }

  if (stem && stem !== word) {
    const stemMatches = WORD_TO_CONCEPTS.get(stem);
    if (stemMatches) {
      for (const item of stemMatches) {
        if (!seenClusters.has(item.cluster)) {
          seenClusters.add(item.cluster);
          results.push(item);
        }
      }
    }
  }

  return results;
}

/**
 * Retrieves semantic concept clusters for a multi-word phrase (e.g. "cash back").
 *
 * @param {string} phrase
 * @returns {Array<{ cluster: string, domain: string }>}
 */
export function getConceptsForPhrase(phrase) {
  if (!phrase || typeof phrase !== 'string') return [];
  const clean = phrase.toLowerCase().trim();
  return WORD_TO_CONCEPTS.get(clean) || [];
}

/**
 * Returns total count of indexed concept vocabulary entries.
 * Useful for diagnostics and test assertions.
 * @returns {number}
 */
export function getConceptVocabularySize() {
  return WORD_TO_CONCEPTS.size;
}

/**
 * Returns total number of registered semantic clusters.
 * @returns {number}
 */
export function getConceptClusterCount() {
  return RAW_CONCEPT_GROUPS.length;
}

export { RAW_CONCEPT_GROUPS };
