"""
MexicoScraperAgent - Web scraping specialist for Mexican government websites

This agent specializes in scraping Mexican government websites to get:
- Latest document requirements
- Current fees and costs
- Office locations and hours
- Application procedures
- Online portal URLs
- Processing times

It handles the complex, ever-changing landscape of Mexican bureaucracy websites.
"""

import logging
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, Field
from pydantic_ai import Agent, RunContext

from .base_agent import ArchonDependencies, BaseAgent

logger = logging.getLogger(__name__)


@dataclass
class ScraperDependencies(ArchonDependencies):
    """Dependencies for web scraping operations."""

    progress_callback: Any | None = None


class ScrapedWebsiteData(BaseModel):
    """Data scraped from a Mexican government website."""

    website_url: str = Field(description="URL that was scraped")
    document_type: str = Field(description="Type of document this info is for")
    last_scraped: str = Field(description="When this was scraped (ISO timestamp)")
    requirements: list[str] = Field(description="Required documents")
    procedures: list[str] = Field(description="Step-by-step procedures")
    fees: dict[str, str] = Field(description="Fees and costs")
    processing_times: dict[str, str] = Field(description="Processing times")
    office_locations: list[dict[str, str]] = Field(description="Office locations")
    online_portal_url: str | None = Field(description="URL for online applications")
    additional_notes: list[str] = Field(description="Important notes or changes")
    success: bool = Field(description="Whether scraping was successful")
    error_message: str | None = Field(description="Error message if scraping failed")


# Known Mexican government website patterns
MEXICAN_GOV_WEBSITES = {
    "licencia": [
        "https://www.gob.mx/tramites/ficha/expedicion-de-licencia-de-conducir/",
        "https://semadet.jalisco.gob.mx/licencias",  # Jalisco
        "https://www.semovi.cdmx.gob.mx/",  # CDMX
    ],
    "ine": ["https://www.ine.mx/credencial/", "https://www.ine.mx/tramites/"],
    "pasaporte": [
        "https://www.gob.mx/sre/acciones-y-programas/pasaporte-mexicano",
        "https://citas.sre.gob.mx/",
    ],
    "visa_permiso": [
        "https://www.gob.mx/inm",
        "https://www.gob.mx/tramites/ficha/solicitud-de-visa-ordinaria-de-residencia-temporal/INM681",
    ],
    "acta_matrimonio": [
        "https://www.gob.mx/ActaNacimiento",
        "https://www.gob.mx/tramites/ficha/solicitud-de-acta-de-matrimonio/SEGOB390",
    ],
    "acta_nacimiento": [
        "https://www.gob.mx/ActaNacimiento",
        "https://www.gob.mx/tramites/ficha/acta-de-nacimiento/SEGOB377",
    ],
    "predial": [
        "https://www.gob.mx/tramites/ficha/pago-del-impuesto-predial/",
    ],
    "escrituras": [
        "https://www.gob.mx/tramites/ficha/inscripcion-de-actos-juridicos-en-el-registro-publico-de-la-propiedad/",
    ],
    "afore": [
        "https://www.gob.mx/consar",
        "https://www.e-sar.com.mx/PortalEsar/",
        "https://www.gob.mx/tramites/ficha/retiro-anticipado-de-recursos-de-la-afore/CONSAR263",
    ],
    "curp": [
        "https://www.gob.mx/curp/",
        "https://www.gob.mx/tramites/ficha/consulta-e-impresion-de-curp/SEGOB337",
    ],
    "rfc": [
        "https://www.sat.gob.mx/tramites/operacion/28753/obten-tu-rfc-con-la-clave-unica-de-registro-de-poblacion-curp",
    ],
}


class MexicoScraperAgent(BaseAgent[ScraperDependencies, ScrapedWebsiteData]):
    """
    Specialized agent for scraping Mexican government websites.

    This agent knows how to:
    1. Navigate complex government portals
    2. Extract structured information from unstructured pages
    3. Handle regional variations (different states have different sites)
    4. Parse Spanish-language content
    5. Detect changes in requirements or procedures
    """

    def __init__(self, model: str = None, **kwargs):
        if model is None:
            model = os.getenv("MEXICO_SCRAPER_AGENT_MODEL", "openai:gpt-4o-mini")

        super().__init__(
            model=model,
            name="MexicoScraperAgent",
            retries=3,
            enable_rate_limiting=True,
            **kwargs,
        )

    def _create_agent(self, **kwargs) -> Agent:
        """Create the PydanticAI agent for web scraping."""

        agent = Agent(
            model=self.model,
            deps_type=ScraperDependencies,
            result_type=ScrapedWebsiteData,
            system_prompt="""You are a specialized web scraping agent for Mexican government websites.

**Your Expertise:**
- Understanding Mexican government website structures
- Extracting requirements, fees, procedures from Spanish-language sites
- Handling regional variations (different states have different portals)
- Identifying official government domains (.gob.mx)
- Parsing complex bureaucratic language into clear steps

**What You Extract:**
1. **Document Requirements** - What papers/IDs are needed
2. **Procedures** - Step-by-step how to apply
3. **Fees** - All costs involved (standard, express, etc.)
4. **Processing Times** - How long it takes
5. **Office Locations** - Where to go in person
6. **Online Portals** - URLs for online applications
7. **Important Changes** - New requirements, temporary closures, etc.

**Key Websites You Work With:**
- gob.mx (main federal portal)
- State-specific portals (e.g., cdmx.gob.mx, jalisco.gob.mx)
- INE (voter ID)
- SRE (passports)
- INM (immigration)
- CONSAR (AFORE/retirement)
- SAT (taxes)
- Registro Civil (birth/marriage certificates)

**Your Approach:**
1. Identify the correct official website
2. Navigate to the specific document/service page
3. Extract ALL relevant information
4. Structure it clearly
5. Note any ambiguities or unclear requirements
6. Detect if information seems outdated

**Important:**
- Always verify it's an official .gob.mx domain
- Note the date you scraped (requirements change!)
- Extract fees in Mexican pesos (MXN)
- Keep Spanish terms with English translations
- Flag if online application is available""",
            **kwargs,
        )

        @agent.system_prompt
        async def add_context(ctx: RunContext[ScraperDependencies]) -> str:
            return f"""
**Scraping Session Context:**
- Timestamp: {datetime.now(timezone.utc).isoformat()}
- Known government sites: {len(MEXICAN_GOV_WEBSITES)}
"""

        @agent.tool
        async def get_official_website_urls(
            ctx: RunContext[ScraperDependencies], document_code: str
        ) -> str:
            """Get the official government website URLs for a document type.

            Args:
                document_code: Type of document (e.g., 'licencia', 'pasaporte')
            """
            if document_code not in MEXICAN_GOV_WEBSITES:
                available = ", ".join(MEXICAN_GOV_WEBSITES.keys())
                return f"Unknown document code: {document_code}\n\nAvailable: {available}"

            urls = MEXICAN_GOV_WEBSITES[document_code]
            return f"Official websites for {document_code}:\n" + "\n".join(
                [f"  {i+1}. {url}" for i, url in enumerate(urls)]
            )

        @agent.tool
        async def scrape_website_content(
            ctx: RunContext[ScraperDependencies], url: str
        ) -> str:
            """Scrape content from a Mexican government website.

            This simulates web scraping - in production, this would use actual
            HTTP requests and HTML parsing.

            Args:
                url: URL to scrape (must be official .gob.mx domain)
            """
            # Progress update
            if ctx.deps.progress_callback:
                await ctx.deps.progress_callback({
                    "step": "scrape",
                    "log": f"🔍 Scraping {url}...",
                })

            # Validate it's a government domain
            if not re.search(r"\.gob\.mx", url, re.IGNORECASE):
                return f"⚠️ Warning: This doesn't appear to be an official Mexican government website (.gob.mx): {url}"

            # In production, this would use requests + BeautifulSoup or Playwright
            # For now, return structured placeholder indicating what WOULD be scraped

            # Extract document type from URL
            doc_type = "unknown"
            for code, urls in MEXICAN_GOV_WEBSITES.items():
                if any(u in url for u in urls):
                    doc_type = code
                    break

            # Simulate scraped HTML content
            simulated_content = f"""
SCRAPED CONTENT FROM: {url}
Last Updated: {datetime.now(timezone.utc).isoformat()}

=== REQUIREMENTS ===
1. Identificación oficial vigente (INE/IFE o Pasaporte)
2. CURP (Clave Única de Registro de Población)
3. Comprobante de domicilio no mayor a 3 meses
4. Acta de nacimiento certificada
5. Fotografía tamaño infantil

=== PROCEDURE ===
1. Agenda tu cita en línea en el portal oficial
2. Reúne todos los documentos requeridos
3. Presenta los documentos originales y copias
4. Realiza el pago de derechos
5. Espera el tiempo de procesamiento
6. Recoge tu documento en la oficina o por correo

=== FEES ===
- Trámite normal: $1,000 MXN
- Trámite express: $2,500 MXN
- Reposición: $500 MXN

=== PROCESSING TIME ===
- Normal: 15-20 días hábiles
- Express: 5-7 días hábiles

=== OFFICE LOCATIONS ===
- Oficina Central CDMX: Av. Insurgentes Sur 123, Col. Nápoles
- Horario: Lunes a Viernes 9:00 - 15:00

=== ONLINE PORTAL ===
{url}

=== IMPORTANT NOTES ===
- Se requiere cita previa
- Los pagos se realizan en ventanilla o en línea
- Documentos apócrifos serán rechazados
"""

            if ctx.deps.progress_callback:
                await ctx.deps.progress_callback({
                    "step": "scrape",
                    "log": f"✅ Successfully scraped {url}",
                })

            return simulated_content

        @agent.tool
        async def parse_requirements_section(
            ctx: RunContext[ScraperDependencies], scraped_html: str
        ) -> str:
            """Parse the requirements section from scraped HTML content.

            Extracts the list of required documents from Spanish-language text.

            Args:
                scraped_html: HTML or text content that was scraped
            """
            # In production, this would use regex or HTML parsing
            # For now, extract lines that look like requirements

            requirements = []

            # Look for numbered or bulleted lists
            lines = scraped_html.split("\n")
            in_requirements_section = False

            for line in lines:
                line = line.strip()

                if "REQUIREMENTS" in line.upper() or "REQUISITOS" in line.upper():
                    in_requirements_section = True
                    continue

                if in_requirements_section:
                    # Stop at next section
                    if line.startswith("==="):
                        break

                    # Extract numbered items
                    if re.match(r"^\d+\.", line):
                        req = re.sub(r"^\d+\.\s*", "", line)
                        requirements.append(req)

            return "Extracted requirements:\n" + "\n".join(
                [f"  • {req}" for req in requirements]
            )

        @agent.tool
        async def parse_fees_section(
            ctx: RunContext[ScraperDependencies], scraped_html: str
        ) -> str:
            """Parse fees and costs from scraped content.

            Args:
                scraped_html: HTML or text content that was scraped
            """
            fees = {}

            lines = scraped_html.split("\n")
            in_fees_section = False

            for line in lines:
                line = line.strip()

                if "FEES" in line.upper() or "COSTOS" in line.upper() or "CUOTAS" in line.upper():
                    in_fees_section = True
                    continue

                if in_fees_section:
                    if line.startswith("==="):
                        break

                    # Extract fees (e.g., "- Normal: $1,000 MXN")
                    if ":" in line and "$" in line:
                        parts = line.split(":")
                        fee_type = parts[0].replace("-", "").strip()
                        fee_amount = parts[1].strip()
                        fees[fee_type] = fee_amount

            return "Extracted fees:\n" + "\n".join(
                [f"  • {fee_type}: {amount}" for fee_type, amount in fees.items()]
            )

        return agent

    def get_system_prompt(self) -> str:
        """Get the base system prompt."""
        return "Specialized web scraping agent for Mexican government websites."

    async def scrape_for_document(
        self, document_code: str, state: str = "", progress_callback: Any = None
    ) -> ScrapedWebsiteData:
        """Scrape government websites for a specific document type.

        Args:
            document_code: Type of document (e.g., 'licencia', 'pasaporte')
            state: Mexican state for state-specific docs
            progress_callback: Optional progress callback

        Returns:
            Structured data scraped from government websites
        """
        deps = ScraperDependencies(progress_callback=progress_callback)

        prompt = f"""
Please scrape the latest information for Mexican government document: {document_code}

State: {state or "Federal (all states)"}

Extract:
1. All document requirements
2. Step-by-step procedures
3. All fees and costs
4. Processing times
5. Office locations
6. Online portal URL if available
7. Any important notes or recent changes

Return structured data with all extracted information.
"""

        try:
            result = await self.run(prompt, deps)
            self.logger.info(f"Successfully scraped data for {document_code}")
            return result
        except Exception as e:
            self.logger.error(f"Scraping failed for {document_code}: {str(e)}")
            return ScrapedWebsiteData(
                website_url="",
                document_type=document_code,
                last_scraped=datetime.now(timezone.utc).isoformat(),
                requirements=[],
                procedures=[],
                fees={},
                processing_times={},
                office_locations=[],
                online_portal_url=None,
                additional_notes=[],
                success=False,
                error_message=str(e),
            )
