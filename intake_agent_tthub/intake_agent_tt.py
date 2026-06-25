# This is the code for our intake agent.

import os
from typing import Literal

from openai import OpenAI
from pydantic import BaseModel, ConfigDict, Field
from pypdf import PdfReader
from agents import Agent
from tools import extract_rfp_text, make_master_string, classify_rfp





api_key = os.environ.get("OPENAI_API_KEY", "").strip()
if not api_key:
    raise RuntimeError("OPENAI_API_KEY is not set.")

client = OpenAI(api_key=api_key)


INTAKE_SCHEMA_VERSION = "bwc_intake_v2"

class StrictOutputModel(BaseModel):
    """Base class for strict Agents SDK structured outputs."""

    model_config = ConfigDict(extra="forbid")


class FeatureFlags(StrictOutputModel):
    mentions_bwc: bool
    mentions_digital_evidence: bool
    mentions_video_evidence: bool
    requests_bwc_hardware: bool
    requests_bwc_accessories: bool
    requests_docking_or_upload: bool
    requests_digital_evidence_platform: bool
    requests_video_storage: bool
    requests_redaction_or_foia_tools: bool
    requests_implementation_services: bool
    requests_maintenance_or_renewal: bool
    has_active_vendor_solicitation: bool
    has_scope_requirements: bool
    has_technical_specs: bool
    has_pricing_or_line_items: bool
    has_submission_instructions: bool
    is_policy_only: bool
    is_training_only: bool
    is_grant_or_funding_only: bool
    is_research_or_report_only: bool
    is_public_records_request_only: bool
    is_meeting_agenda_or_minutes: bool
    is_budget_line_item_only: bool
    is_adjacent_public_safety_tech: bool
    bwc_mentioned_only_in_passing: bool


class Evidence(StrictOutputModel):
    summary: str
    sections_used: list[str]
    key_excerpts: list[str]
    primary_scope: str
    procurement_terms_found: list[str]


class ClassificationReasoning(StrictOutputModel):
    short_reason: str
    why_match_or_not: str
    disqualifying_reason: str


class Review(StrictOutputModel):
    review_required: bool
    review_reason: str


class IntakeClassification(StrictOutputModel):
    """Typed result returned by the intake agent."""

    schema_version: Literal["bwc_intake_v2"]
    final_label: Literal["BWC_RELATED", "NOT_BWC_RELATED", "UNCERTAIN"]
    is_bwc_match: bool
    match_score: int = Field(ge=0, le=100)
    confidence: Literal["HIGH", "MEDIUM", "LOW"]
    opportunity_type: Literal[
        "DIRECT_BWC",
        "BWC_EXPANSION",
        "BWC_REPLACEMENT",
        "DIGITAL_EVIDENCE_ONLY",
        "VIDEO_ECOSYSTEM",
        "BWC_STORAGE_OR_MAINTENANCE",
        "REDACTION_OR_FOIA_WORKFLOW",
        "TRAINING_OR_POLICY_ONLY",
        "GRANT_OR_FUNDING_ONLY",
        "RESEARCH_OR_REPORT_ONLY",
        "ADJACENT_PUBLIC_SAFETY_TECH",
        "NOT_RELEVANT",
        "HUMAN_REVIEW",
    ]
    document_type: Literal[
        "RFP",
        "RFQ",
        "RFI",
        "BID",
        "SOLICITATION",
        "CONTRACT_OR_AWARD",
        "AGENDA_OR_MINUTES",
        "BUDGET_DOCUMENT",
        "GRANT_DOCUMENT",
        "POLICY_OR_PROCEDURE",
        "PUBLIC_RECORDS_REQUEST",
        "TRAINING_DOCUMENT",
        "RESEARCH_REPORT",
        "OTHER",
        "UNKNOWN",
    ]
    procurement_stage: Literal[
        "ACTIVE_SOLICITATION",
        "PRE_SOLICITATION",
        "AWARD_OR_APPROVAL",
        "BUDGETING_OR_PLANNING",
        "INFORMATIONAL_ONLY",
        "NOT_A_PROCUREMENT",
        "UNKNOWN",
    ]
    procurement_intent: Literal[
        "BUY_OR_REPLACE_PRODUCTS",
        "IMPLEMENT_OR_EXPAND_SYSTEM",
        "MAINTAIN_OR_RENEW_EXISTING_SYSTEM",
        "REQUEST_INFORMATION",
        "FUND_OR_REIMBURSE_PROGRAM",
        "TRAINING_SERVICES",
        "POLICY_OR_RESEARCH",
        "UNRELATED_PURCHASE",
        "NO_BUYING_INTENT",
        "UNKNOWN",
    ]
    feature_flags: FeatureFlags
    positive_signal_codes: list[
        Literal[
            "BWC_HARDWARE_REQUESTED",
            "BWC_REPLACEMENT_OR_EXPANSION",
            "DIGITAL_EVIDENCE_PLATFORM_REQUESTED",
            "VIDEO_EVIDENCE_WORKFLOW_REQUESTED",
            "BWC_STORAGE_REQUESTED",
            "REDACTION_OR_FOIA_TOOLS_REQUESTED",
            "DOCKING_UPLOAD_OR_ACCESSORIES_REQUESTED",
            "IMPLEMENTATION_OR_TRAINING_FOR_BWC_SYSTEM",
            "MAINTENANCE_OR_RENEWAL_FOR_BWC_SYSTEM",
            "ACTIVE_VENDOR_SOLICITATION",
            "BWC_PRICING_OR_LINE_ITEMS",
        ]
    ]
    negative_signal_codes: list[
        Literal[
            "NO_BWC_OR_DEMS_SCOPE",
            "NO_ACTIVE_SOLICITATION",
            "MENTION_ONLY",
            "POLICY_ONLY",
            "TRAINING_ONLY",
            "GRANT_ONLY",
            "RESEARCH_OR_REPORT_ONLY",
            "PUBLIC_RECORDS_REQUEST_ONLY",
            "AGENDA_OR_MINUTES_ONLY",
            "BUDGET_LINE_ITEM_ONLY",
            "ADJACENT_TECH_ONLY",
            "UNRELATED_PRIMARY_SCOPE",
            "NO_VENDOR_SUBMISSION_PATH",
            "INSUFFICIENT_EVIDENCE",
        ]
    ]
    evidence: Evidence
    reasoning: ClassificationReasoning
    review: Review


intake_agent_prompt = """
You are an expert public safety procurement analyst for Trusted Tech.

Your task is to review an RFP, bid, solicitation, RFQ, RFI, or procurement document and determine whether it is relevant to Body-Worn Cameras (BWC), Digital Evidence Management, or closely related public safety video technologies.

You are helping build a high-quality labeled dataset that will later be used to train and evaluate an automated intake agent. The output must be consistent enough for machine learning, analytics, and backend routing.

The document may be long and may contain boilerplate procurement language. Do not treat every section equally. Focus on the parts of the document that determine the actual procurement need.

Before classifying, identify the most relevant evidence from the document, including any useful information from:

- title
- introduction
- purpose
- scope of work
- objectives
- technical specifications
- requirements
- deliverables
- pricing line items
- product/service descriptions
- attachments or exhibits

Ignore generic procurement boilerplate unless it directly affects the classification.

Classify the document into exactly one final_label:

1. BWC_RELATED
2. NOT_BWC_RELATED
3. UNCERTAIN

Label Definitions:

BWC_RELATED:

- The procurement directly involves body-worn cameras, officer-worn cameras, wearable cameras, digital evidence management systems, video evidence platforms, BWC replacement projects, BWC expansion projects, evidence redaction tools, docking stations, BWC accessories, or technologies primarily used to manage body-camera footage.
- If Trusted Tech would reasonably pursue this opportunity, choose BWC_RELATED.
- is_bwc_match must be true.
- match_score should usually be 70-100.

NOT_BWC_RELATED:

- The procurement is unrelated to body-worn cameras or digital evidence workflows.
- Examples include CAD, RMS, radio systems, cybersecurity, construction, vehicles, fire apparatus, networking equipment, general IT services, and unrelated software procurements.
- If Trusted Tech would not realistically pursue the opportunity, choose NOT_BWC_RELATED.
- This includes documents that mention BWC only in passing, only discuss policy/training/research, only accept grant funding, only describe public records/FOIA access to existing footage, or only include BWC as a minor budget line item.
- is_bwc_match must be false.
- match_score should usually be 0-39.

UNCERTAIN:

- The document contains references to video, evidence, public safety technology, investigations, surveillance, media management, or related concepts, but there is insufficient evidence to confidently determine whether body-worn cameras or related digital evidence workflows are part of the procurement.
- Human review would be required.
- is_bwc_match must be false unless the document is more likely relevant than not.
- match_score should usually be 40-69.

Important Instructions:

- Do not rely solely on keywords.
- Consider the overall purpose of the procurement.
- If body-worn cameras are only mentioned in passing and are not part of the procurement, do not automatically classify as BWC_RELATED.
- Be conservative. If evidence is insufficient, choose UNCERTAIN.
- Base all conclusions only on information found in the document.
- If the document is long, summarize only the evidence that matters for classification.
- Return JSON only using the provided schema. Do not add fields that are not in the schema.
- Every boolean feature flag must be explicitly true or false.
- Prefer stable enum codes over creative wording.
- For key_excerpts, quote or closely paraphrase short text from the document. Do not invent evidence.
- Use "NONE" for review_reason or disqualifying_reason when no reason applies.
- match_score must be an integer from 0 to 100.

Classification Rules:

- If final_label is BWC_RELATED, is_bwc_match must be true.
- If final_label is NOT_BWC_RELATED, is_bwc_match must be false.
- If final_label is UNCERTAIN, review.review_required must be true.
- If confidence is LOW, review.review_required must be true.
- Use HUMAN_REVIEW as opportunity_type when final_label is UNCERTAIN.
- Use NOT_RELEVANT only when no more specific non-relevant opportunity_type applies.
- Use TRAINING_OR_POLICY_ONLY when BWC is only present in training, policies, procedures, or accreditation language.
- Use GRANT_OR_FUNDING_ONLY when the document only accepts, announces, describes, or reimburses grant funding and does not solicit BWC/DEMS vendors.
- Use RESEARCH_OR_REPORT_ONLY when the document studies, summarizes, audits, or reports on BWC without being an active vendor opportunity.
- Use ADJACENT_PUBLIC_SAFETY_TECH for CAD, RMS, radios, mobile data computers, generic IT, networking, surveillance, or other nearby public safety tech that does not procure BWC/DEMS.
- Use REDACTION_OR_FOIA_WORKFLOW only when redaction, public records, FOIA, or disclosure workflows are the primary opportunity type.
- If a document requests a digital evidence platform for police video/evidence but does not explicitly request cameras, DIGITAL_EVIDENCE_ONLY can still be BWC_RELATED when Trusted Tech would reasonably pursue it.
- If the document is only about public requests for existing footage, records fees, policy review, meeting minutes, or research, it is NOT_BWC_RELATED even if it contains many BWC terms.

Feature Flag Guidance:

- has_active_vendor_solicitation means the document is asking vendors to submit bids/proposals/quotes now.
- has_scope_requirements means the document states work, deliverables, products, or services expected from a vendor.
- has_technical_specs means the document includes product, system, security, integration, performance, storage, upload, camera, or software requirements.
- has_pricing_or_line_items means the document has pricing tables, quantities, bid items, or budget items relevant to the opportunity.
- bwc_mentioned_only_in_passing means BWC appears but is not part of the primary procurement need.

Output Field Meaning:

- final_label is the primary training label.
- is_bwc_match is the binary backend routing value.
- match_score is a calibrated relevance score for ranking and threshold tuning.
- opportunity_type, document_type, procurement_stage, procurement_intent, feature_flags, positive_signal_codes, and negative_signal_codes are normalized ML features.
- evidence and reasoning are for auditability and future human relabeling.
"""






#Define the Intake agent 

intake_agent = Agent(
    name = "Intake Agent",
    instructions = intake_agent_prompt,
    tools = [extract_rfp_text, make_master_string],
    output_type = IntakeClassification,
)
