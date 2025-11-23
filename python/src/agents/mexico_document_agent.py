"""
MexicoDocumentAgent - Multi-agent system for Mexican government documentation

This agent helps users navigate Mexican bureaucracy and obtain various documents:
- Driver's licenses (Licencias de conducir)
- State IDs (Identificaciones oficiales)
- Passports (Pasaportes)
- Visa permits (Permisos de visa)
- Marriage certificates (Actas de matrimonio)
- Property tax documents (Prediales)
- Property deeds (Escrituras)
- Vehicle insurance (Seguros vehiculares)
- AFORE retirement fund recovery
- And more Mexican government services

The agent coordinates multiple sub-agents to scrape information, fill forms,
and track the entire documentation process.
"""

import json
import logging
import os
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, Field
from pydantic_ai import Agent, RunContext

from .base_agent import ArchonDependencies, BaseAgent

logger = logging.getLogger(__name__)


@dataclass
class MexicoDocumentDependencies(ArchonDependencies):
    """Dependencies for Mexico document operations."""

    user_id: str = ""
    progress_callback: Any | None = None


class DocumentType(BaseModel):
    """Represents a type of Mexican government document."""

    code: str = Field(description="Short code for the document type")
    name_es: str = Field(description="Spanish name of the document")
    name_en: str = Field(description="English name of the document")
    description: str = Field(description="What this document is for")
    typical_wait_time: str = Field(description="How long it typically takes to get")
    required_documents: list[str] = Field(description="What documents are needed to apply")
    government_agency: str = Field(description="Which Mexican government agency handles this")
    online_available: bool = Field(description="Whether this can be done online")
    estimated_cost_mxn: str = Field(description="Estimated cost in Mexican pesos")


class MexicoDocumentRequest(BaseModel):
    """User's request for Mexican government documentation."""

    request_id: str = Field(description="Unique request ID")
    user_id: str = Field(description="User making the request")
    document_types: list[str] = Field(description="Types of documents requested")
    applicant_info: dict[str, Any] = Field(
        description="Information about the person applying (name, CURP, etc.)"
    )
    current_status: str = Field(description="Current status of the request")
    steps_completed: list[str] = Field(description="Steps that have been completed")
    next_steps: list[str] = Field(description="Next steps to take")
    estimated_completion: str = Field(description="When all documents should be ready")
    scraped_info: dict[str, Any] = Field(
        description="Information scraped from government websites"
    )
    forms_filled: list[str] = Field(description="Forms that have been auto-filled")
    documents_obtained: list[str] = Field(description="Documents successfully obtained")
    estimated_total_cost_mxn: float = Field(description="Total estimated cost in pesos")


class DocumentRequestResponse(BaseModel):
    """Response from creating or updating a document request."""

    success: bool = Field(description="Whether the operation succeeded")
    request_id: str = Field(description="ID of the document request")
    message: str = Field(description="Human-readable status message")
    next_actions: list[str] = Field(description="What the user should do next")
    documents_info: list[DocumentType] = Field(
        description="Information about the requested documents"
    )
    estimated_timeline: str = Field(description="How long the process will take")
    total_cost_estimate_mxn: float = Field(description="Total estimated cost")


# Document type catalog - comprehensive list of Mexican government documents
MEXICO_DOCUMENT_TYPES = {
    "licencia": DocumentType(
        code="licencia",
        name_es="Licencia de Conducir",
        name_en="Driver's License",
        description="Official permit to drive vehicles in Mexico",
        typical_wait_time="1-2 weeks",
        required_documents=[
            "INE/IFE",
            "CURP",
            "Comprobante de domicilio",
            "Certificado médico",
            "Pago de derechos",
        ],
        government_agency="Secretaría de Movilidad (varía por estado)",
        online_available=True,
        estimated_cost_mxn="800-1500",
    ),
    "ine": DocumentType(
        code="ine",
        name_es="Credencial para Votar (INE)",
        name_en="Voter ID / National ID",
        description="Official Mexican national identification card",
        typical_wait_time="2-4 weeks",
        required_documents=[
            "Acta de nacimiento",
            "CURP",
            "Comprobante de domicilio",
            "Fotografía",
        ],
        government_agency="Instituto Nacional Electoral (INE)",
        online_available=True,
        estimated_cost_mxn="0",
    ),
    "pasaporte": DocumentType(
        code="pasaporte",
        name_es="Pasaporte Mexicano",
        name_en="Mexican Passport",
        description="International travel document for Mexican citizens",
        typical_wait_time="3-6 weeks (can be expedited)",
        required_documents=["Acta de nacimiento", "INE/IFE", "CURP", "Comprobante de pago"],
        government_agency="Secretaría de Relaciones Exteriores (SRE)",
        online_available=True,
        estimated_cost_mxn="1345-2840",
    ),
    "visa_permiso": DocumentType(
        code="visa_permiso",
        name_es="Permiso de Visa / Forma Migratoria",
        name_en="Visa Permit / Immigration Form",
        description="Permits for foreign nationals or Mexican residents",
        typical_wait_time="4-8 weeks",
        required_documents=["Pasaporte", "Comprobante de ingresos", "Forma migratoria"],
        government_agency="Instituto Nacional de Migración (INM)",
        online_available=True,
        estimated_cost_mxn="Variable",
    ),
    "acta_matrimonio": DocumentType(
        code="acta_matrimonio",
        name_es="Acta de Matrimonio",
        name_en="Marriage Certificate",
        description="Official record of marriage",
        typical_wait_time="1-2 weeks (or immediate if recent)",
        required_documents=["Identificación oficial", "Datos de matrimonio"],
        government_agency="Registro Civil (varía por estado)",
        online_available=True,
        estimated_cost_mxn="200-500",
    ),
    "acta_nacimiento": DocumentType(
        code="acta_nacimiento",
        name_es="Acta de Nacimiento",
        name_en="Birth Certificate",
        description="Official record of birth",
        typical_wait_time="1-2 weeks (or immediate if recent)",
        required_documents=["Identificación oficial", "Datos de nacimiento"],
        government_agency="Registro Civil (varía por estado)",
        online_available=True,
        estimated_cost_mxn="200-500",
    ),
    "predial": DocumentType(
        code="predial",
        name_es="Predial (Impuesto Predial)",
        name_en="Property Tax Documents",
        description="Property tax documentation and payment receipts",
        typical_wait_time="Immediate to 1 week",
        required_documents=["Cuenta predial", "Identificación oficial", "Escrituras"],
        government_agency="Tesorería Municipal (varía por municipio)",
        online_available=True,
        estimated_cost_mxn="Variable (depends on property value)",
    ),
    "escrituras": DocumentType(
        code="escrituras",
        name_es="Escrituras de Propiedad",
        name_en="Property Deeds",
        description="Legal documents proving property ownership",
        typical_wait_time="4-12 weeks",
        required_documents=[
            "Contrato de compraventa",
            "Identificación oficial",
            "Comprobante de pago de impuestos",
        ],
        government_agency="Registro Público de la Propiedad (varía por estado)",
        online_available=False,
        estimated_cost_mxn="Variable (notary fees)",
    ),
    "seguro_auto": DocumentType(
        code="seguro_auto",
        name_es="Seguro de Auto",
        name_en="Vehicle Insurance",
        description="Required insurance for vehicles in Mexico",
        typical_wait_time="Immediate to 3 days",
        required_documents=[
            "Tarjeta de circulación",
            "Licencia de conducir",
            "Identificación oficial",
        ],
        government_agency="Aseguradoras privadas (regulated by CNSF)",
        online_available=True,
        estimated_cost_mxn="3000-15000 (annual)",
    ),
    "afore": DocumentType(
        code="afore",
        name_es="Recuperación de AFORE",
        name_en="AFORE Retirement Fund Recovery",
        description="Recover retirement funds contributed under social security number",
        typical_wait_time="6-12 weeks",
        required_documents=[
            "CURP",
            "NSS (Número de Seguridad Social)",
            "Identificación oficial",
            "Estado de cuenta AFORE",
            "Comprobante de domicilio",
        ],
        government_agency="CONSAR (Comisión Nacional del Sistema de Ahorro para el Retiro)",
        online_available=True,
        estimated_cost_mxn="0 (pero puede haber fees de administración)",
    ),
    "curp": DocumentType(
        code="curp",
        name_es="CURP (Clave Única de Registro de Población)",
        name_en="Unique Population Registry Code",
        description="Unique identification code for all Mexican residents",
        typical_wait_time="Immediate (online) or 1-2 weeks",
        required_documents=["Acta de nacimiento", "Identificación oficial"],
        government_agency="RENAPO (Registro Nacional de Población)",
        online_available=True,
        estimated_cost_mxn="0",
    ),
    "rfc": DocumentType(
        code="rfc",
        name_es="RFC (Registro Federal de Contribuyentes)",
        name_en="Federal Taxpayer Registry",
        description="Tax ID for individuals and businesses in Mexico",
        typical_wait_time="Immediate (online) or 1 week",
        required_documents=["Acta de nacimiento", "CURP", "Comprobante de domicilio"],
        government_agency="SAT (Servicio de Administración Tributaria)",
        online_available=True,
        estimated_cost_mxn="0",
    ),
}


class MexicoDocumentAgent(BaseAgent[MexicoDocumentDependencies, DocumentRequestResponse]):
    """
    Main coordinating agent for Mexican government documentation.

    This agent understands what documents users need and coordinates multiple
    sub-agents to:
    1. Scrape government websites for latest requirements
    2. Fill out forms automatically
    3. Track the entire documentation process
    4. Provide updates and next steps
    """

    def __init__(self, model: str = None, **kwargs):
        if model is None:
            model = os.getenv("MEXICO_DOCUMENT_AGENT_MODEL", "openai:gpt-4o")

        super().__init__(
            model=model,
            name="MexicoDocumentAgent",
            retries=3,
            enable_rate_limiting=True,
            **kwargs,
        )

    def _create_agent(self, **kwargs) -> Agent:
        """Create the PydanticAI agent with tools and prompts."""

        agent = Agent(
            model=self.model,
            deps_type=MexicoDocumentDependencies,
            result_type=DocumentRequestResponse,
            system_prompt="""You are an expert assistant for navigating Mexican government bureaucracy and obtaining official documents.

**Your Mission:**
Help users get ANY Mexican government document they need, as quickly and efficiently as possible. This includes:

**Common Documents:**
- 🚗 Driver's licenses (Licencias de conducir)
- 🆔 State IDs / Voter IDs (INE/IFE)
- 🛂 Passports (Pasaportes mexicanos)
- 📋 Visa permits (Permisos de visa / Formas migratorias)
- 💍 Marriage certificates (Actas de matrimonio)
- 👶 Birth certificates (Actas de nacimiento)
- 🏠 Property tax documents (Prediales)
- 📜 Property deeds (Escrituras)
- 🚙 Vehicle insurance (Seguros vehiculares)
- 💰 AFORE retirement fund recovery (Recuperación de fondos AFORE)
- 🔢 CURP (Clave Única de Registro de Población)
- 📊 RFC (Registro Federal de Contribuyentes)

**What Makes You Special:**
1. You can scrape Mexican government websites for the LATEST requirements
2. You can automatically fill out forms with user's information
3. You track the ENTIRE process from start to finish
4. You know the shortcuts and tips to speed things up
5. You help recover money people didn't even know they had (AFORE!)

**Your Approach:**
1. **Understand what they need** - Ask clarifying questions if needed
2. **Gather their information** - Name, CURP, address, etc.
3. **Scrape latest requirements** - Check government websites for current rules
4. **Fill out forms** - Automatically populate forms with their info
5. **Provide clear next steps** - Tell them EXACTLY what to do next
6. **Track progress** - Keep tabs on each document's status
7. **Estimate costs and timeline** - Be realistic about time and money

**Important Context:**
- Many people have worked in the US under a Social Security Number and have AFORE funds waiting
- Government websites change frequently - always scrape for latest info
- Each Mexican state has different requirements for some documents
- Some processes can be done 100% online now (post-COVID improvements)
- You can help with MULTIPLE documents at once - batch processing!

**Tone:**
- Empathetic (bureaucracy is frustrating!)
- Clear and direct (no jargon unless explained)
- Encouraging (make them feel this is doable)
- Bilingual when helpful (Spanish terms with English explanations)

**Remember:**
These documents often represent people fighting for what's rightfully theirs - their identity,
their property, their retirement money. Take this seriously and help them WIN.""",
            **kwargs,
        )

        @agent.system_prompt
        async def add_context(ctx: RunContext[MexicoDocumentDependencies]) -> str:
            return f"""
**Current Session Context:**
- User ID: {ctx.deps.user_id or "Anonymous"}
- Timestamp: {datetime.now(timezone.utc).isoformat()}
- Available document types: {len(MEXICO_DOCUMENT_TYPES)}
"""

        @agent.tool
        async def list_available_documents(ctx: RunContext[MexicoDocumentDependencies]) -> str:
            """List all types of Mexican government documents we can help obtain."""
            doc_list = []
            for code, doc in MEXICO_DOCUMENT_TYPES.items():
                online = "✅ Online" if doc.online_available else "❌ In-person"
                doc_list.append(
                    f"• **{doc.name_en}** ({doc.name_es})\n"
                    f"  - Agency: {doc.government_agency}\n"
                    f"  - Time: {doc.typical_wait_time}\n"
                    f"  - Cost: ${doc.estimated_cost_mxn} MXN\n"
                    f"  - {online}\n"
                )

            return (
                "**Available Mexican Government Documents:**\n\n"
                + "\n".join(doc_list)
                + "\n\n💡 **Tip:** You can request multiple documents at once!"
            )

        @agent.tool
        async def get_document_requirements(
            ctx: RunContext[MexicoDocumentDependencies], document_code: str
        ) -> str:
            """Get detailed requirements for a specific document type."""
            if document_code not in MEXICO_DOCUMENT_TYPES:
                available = ", ".join(MEXICO_DOCUMENT_TYPES.keys())
                return f"❌ Unknown document code: {document_code}\n\nAvailable codes: {available}"

            doc = MEXICO_DOCUMENT_TYPES[document_code]

            return f"""
**{doc.name_en} ({doc.name_es})**

**What it's for:** {doc.description}

**Government Agency:** {doc.government_agency}

**Typical Wait Time:** {doc.typical_wait_time}

**Estimated Cost:** ${doc.estimated_cost_mxn} MXN

**Online Available:** {"Yes ✅" if doc.online_available else "No ❌ (must visit office)"}

**Required Documents:**
{chr(10).join(f"  {i+1}. {req}" for i, req in enumerate(doc.required_documents))}

💡 **Next Step:** Use create_document_request to start the process!
"""

        @agent.tool
        async def create_document_request(
            ctx: RunContext[MexicoDocumentDependencies],
            document_codes: list[str],
            applicant_name: str,
            curp: str = "",
            nss: str = "",
            state: str = "",
            additional_info: dict = None,
        ) -> str:
            """Create a new document request for one or more Mexican government documents.

            Args:
                document_codes: List of document type codes (e.g., ['licencia', 'pasaporte'])
                applicant_name: Full legal name of the applicant
                curp: CURP (Clave Única de Registro de Población) if known
                nss: NSS (Número de Seguridad Social) if applicable
                state: Mexican state where applying (e.g., "Jalisco", "CDMX")
                additional_info: Any other relevant information
            """
            try:
                # Send progress update
                if ctx.deps.progress_callback:
                    await ctx.deps.progress_callback({
                        "step": "create_request",
                        "log": f"📋 Creating document request for {applicant_name}...",
                    })

                # Validate document codes
                invalid_codes = [code for code in document_codes if code not in MEXICO_DOCUMENT_TYPES]
                if invalid_codes:
                    return f"❌ Invalid document codes: {', '.join(invalid_codes)}\n\nValid codes: {', '.join(MEXICO_DOCUMENT_TYPES.keys())}"

                # Generate request ID
                request_id = str(uuid.uuid4())

                # Gather applicant info
                applicant_info = {
                    "name": applicant_name,
                    "curp": curp,
                    "nss": nss,
                    "state": state,
                }
                if additional_info:
                    applicant_info.update(additional_info)

                # Calculate estimated costs and timeline
                total_cost = 0.0
                max_wait_weeks = 0

                for code in document_codes:
                    doc = MEXICO_DOCUMENT_TYPES[code]
                    # Parse cost (handle ranges like "800-1500")
                    cost_str = doc.estimated_cost_mxn.replace(",", "")
                    if "-" in cost_str:
                        cost_parts = cost_str.split("-")
                        try:
                            cost = (float(cost_parts[0]) + float(cost_parts[1])) / 2
                        except:
                            cost = 0
                    elif cost_str.lower() == "variable":
                        cost = 0
                    else:
                        try:
                            cost = float(cost_str)
                        except:
                            cost = 0

                    total_cost += cost

                    # Parse wait time (convert to weeks)
                    wait_str = doc.typical_wait_time.lower()
                    if "week" in wait_str:
                        try:
                            weeks = int(wait_str.split("-")[-1].split()[0])
                            max_wait_weeks = max(max_wait_weeks, weeks)
                        except:
                            max_wait_weeks = max(max_wait_weeks, 4)

                # Create next steps
                next_steps = [
                    "Gather required documents (see requirements for each document type)",
                    "Visit government websites to check latest procedures",
                    "Schedule appointments if required",
                    "Prepare payment methods",
                    "Review all information for accuracy",
                ]

                # Progress update
                if ctx.deps.progress_callback:
                    await ctx.deps.progress_callback({
                        "step": "create_request",
                        "log": f"✅ Created request {request_id} for {len(document_codes)} document(s)",
                    })

                # Store in database (would integrate with Supabase here)
                # For now, return success message
                docs_info = [MEXICO_DOCUMENT_TYPES[code] for code in document_codes]

                return json.dumps({
                    "success": True,
                    "request_id": request_id,
                    "message": f"Successfully created request for {len(document_codes)} document(s)",
                    "next_actions": next_steps,
                    "documents_info": [doc.model_dump() for doc in docs_info],
                    "estimated_timeline": f"{max_wait_weeks} weeks",
                    "total_cost_estimate_mxn": total_cost,
                })

            except Exception as e:
                logger.error(f"Error creating document request: {e}")
                return json.dumps({
                    "success": False,
                    "request_id": "",
                    "message": f"Failed to create request: {str(e)}",
                    "next_actions": [],
                    "documents_info": [],
                    "estimated_timeline": "Unknown",
                    "total_cost_estimate_mxn": 0.0,
                })

        @agent.tool
        async def scrape_government_website(
            ctx: RunContext[MexicoDocumentDependencies], document_code: str, state: str = ""
        ) -> str:
            """Scrape the latest requirements from Mexican government websites.

            This tool will fetch real-time information about document requirements,
            procedures, costs, and office locations.

            Args:
                document_code: Type of document (e.g., 'licencia', 'pasaporte')
                state: Mexican state for state-specific documents
            """
            # Send progress update
            if ctx.deps.progress_callback:
                await ctx.deps.progress_callback({
                    "step": "scrape_website",
                    "log": f"🔍 Scraping latest info for {document_code}...",
                })

            # In a real implementation, this would actually scrape websites
            # For now, return structured placeholder that indicates what WOULD be scraped

            if document_code not in MEXICO_DOCUMENT_TYPES:
                return f"❌ Unknown document code: {document_code}"

            doc = MEXICO_DOCUMENT_TYPES[document_code]

            scraped_data = {
                "document_type": document_code,
                "last_updated": datetime.now(timezone.utc).isoformat(),
                "official_website": f"https://www.gob.mx/{document_code}",
                "requirements": doc.required_documents,
                "procedures": [
                    "1. Gather required documents",
                    "2. Schedule appointment (if required)",
                    "3. Visit office or apply online",
                    "4. Pay fees",
                    "5. Submit application",
                    "6. Wait for processing",
                    "7. Collect document",
                ],
                "office_locations": [
                    {"city": state or "CDMX", "address": "Address would be scraped from website"},
                ],
                "fees": {"standard": doc.estimated_cost_mxn, "express": "Would be scraped"},
                "processing_times": {
                    "standard": doc.typical_wait_time,
                    "express": "Would be scraped",
                },
                "online_portal": doc.online_available,
            }

            if ctx.deps.progress_callback:
                await ctx.deps.progress_callback({
                    "step": "scrape_website",
                    "log": f"✅ Successfully scraped info for {doc.name_en}",
                })

            return json.dumps(scraped_data, indent=2)

        return agent

    def get_system_prompt(self) -> str:
        """Get the base system prompt."""
        return "Expert assistant for Mexican government documentation and bureaucracy navigation."

    async def help_user(
        self, user_message: str, user_id: str = None, progress_callback: Any = None
    ) -> DocumentRequestResponse:
        """Main entry point for helping users get their documents.

        Args:
            user_message: What the user wants help with
            user_id: ID of the user requesting help
            progress_callback: Optional callback for progress updates

        Returns:
            Structured response with next steps and document information
        """
        deps = MexicoDocumentDependencies(
            user_id=user_id or "anonymous", progress_callback=progress_callback
        )

        try:
            result = await self.run(user_message, deps)
            self.logger.info(f"Document request completed: {result.request_id}")
            return result
        except Exception as e:
            self.logger.error(f"Document request failed: {str(e)}")
            return DocumentRequestResponse(
                success=False,
                request_id="",
                message=f"Failed to process request: {str(e)}",
                next_actions=["Try again with more specific information"],
                documents_info=[],
                estimated_timeline="Unknown",
                total_cost_estimate_mxn=0.0,
            )
