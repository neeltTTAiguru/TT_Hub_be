import asyncio
import json
from openai import OpenAI
from pydantic import BaseModel
from textwrap import dedent
from pypdf import PdfReader
from agents import Agent
from agents import Agent, Runner, function_tool,set_default_openai_key




@function_tool
def extract_rfp_text(rfp: str) -> list[str]:
    pdf_read = PdfReader(rfp)
    text_list = []
    for page in pdf_read.pages:
        text_list.append(page.extract_text()or "")
    return text_list 


@function_tool
def make_master_string(rfp_text_list: list[str]) -> str:
    master_string = ""
    for page in rfp_text_list:
        master_string = master_string + page
    return master_string


@function_tool
def classify_rfp(pdf_path: str):
    rfp_text = make_master_string(extract_rfp_text(pdf_path))
    response = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": intake_agent_prompt},
            {
                "role": "user",
                "content": (
                    "Classify this RFP using your instructions. "
                    "Return valid JSON only.\n\n"
                    f"PDF path: {pdf_path}\n\n"
                    f"RFP text:\n{rfp_text}"
                ),
            },
        ],
        response_format={
            "type": "json_schema",
            "json_schema": INTAKE_CLASSIFICATION_SCHEMA,
        },
    )
    return response.choices[0].message.content

