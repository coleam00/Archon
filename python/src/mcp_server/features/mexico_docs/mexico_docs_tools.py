"""
MCP Tools for Mexico Document Processing

Exposes tools to AI assistants (Cursor, Windsurf, Claude Desktop) for helping users
obtain Mexican government documents.
"""

import json
import logging

from mcp.server.fastmcp import Context, FastMCP

logger = logging.getLogger(__name__)


def register_mexico_docs_tools(mcp: FastMCP):
    """Register all Mexico document tools with the MCP server."""

    @mcp.tool()
    async def mexico_list_document_types(ctx: Context) -> str:
        """List all available Mexican government document types that can be obtained.

Returns information about each document type including:
- Document name (Spanish and English)
- Government agency responsible
- Typical processing time
- Estimated costs
- Whether online application is available
- Required documents

Use this to show users what documents are available."""
        Tool(
            name="archon:mexico_get_document_requirements",
            description="""Get detailed requirements for a specific Mexican government document.

Returns comprehensive information including:
- All required documents and identification
- Step-by-step application procedure
- Current fees and costs
- Processing times (standard and express)
- Office locations (if in-person required)
- Online portal URL (if available)
- Important notes and recent changes

The information is scraped from official government websites to ensure accuracy.""",
            inputSchema={
                "type": "object",
                "properties": {
                    "document_code": {
                        "type": "string",
                        "description": "Document type code (e.g., 'licencia', 'pasaporte', 'afore')",
                    },
                    "state": {
                        "type": "string",
                        "description": "Mexican state (optional, for state-specific documents like driver's license)",
                    },
                },
                "required": ["document_code"],
            },
        ),
        Tool(
            name="archon:mexico_create_document_request",
            description="""Create a new request to obtain one or more Mexican government documents.

This starts the process of helping the user get their documents. It will:
1. Validate the requested documents
2. Calculate total estimated costs
3. Determine timeline
4. Provide clear next steps
5. Track the entire process

The system can handle multiple documents at once (e.g., passport + driver's license + AFORE recovery).

Returns a request_id that can be used to track progress.""",
            inputSchema={
                "type": "object",
                "properties": {
                    "document_codes": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Array of document type codes to request (e.g., ['licencia', 'pasaporte', 'afore'])",
                    },
                    "applicant_name": {
                        "type": "string",
                        "description": "Full legal name of the person applying",
                    },
                    "curp": {
                        "type": "string",
                        "description": "CURP (Clave Única de Registro de Población) if known",
                    },
                    "nss": {
                        "type": "string",
                        "description": "NSS (Número de Seguridad Social) - required for AFORE recovery",
                    },
                    "state": {
                        "type": "string",
                        "description": "Mexican state where applying (e.g., 'Jalisco', 'CDMX')",
                    },
                    "user_id": {
                        "type": "string",
                        "description": "User ID (optional, for tracking)",
                    },
                    "additional_info": {
                        "type": "object",
                        "description": "Any additional applicant information (email, phone, address, etc.)",
                    },
                },
                "required": ["document_codes", "applicant_name"],
            },
        ),
        Tool(
            name="archon:mexico_get_request_status",
            description="""Get the current status of a document request.

Returns:
- Current status (pending, in_progress, completed, failed)
- Documents requested
- Steps completed
- Next steps to take
- Documents obtained so far
- Estimated completion date
- Total costs (estimated and actual)""",
            inputSchema={
                "type": "object",
                "properties": {
                    "request_id": {
                        "type": "string",
                        "description": "The request ID returned when creating the request",
                    },
                },
                "required": ["request_id"],
            },
        ),
        Tool(
            name="archon:mexico_update_request_progress",
            description="""Update the progress of a document request.

Use this to mark steps as completed, record obtained documents,
update costs, or change status.

Examples:
- Mark "Gathered birth certificate" as completed
- Record that passport was obtained
- Update actual costs paid
- Change status to completed""",
            inputSchema={
                "type": "object",
                "properties": {
                    "request_id": {
                        "type": "string",
                        "description": "The request ID to update",
                    },
                    "step_completed": {
                        "type": "string",
                        "description": "Description of step that was completed",
                    },
                    "document_obtained": {
                        "type": "string",
                        "description": "Document code that was successfully obtained",
                    },
                    "actual_cost_mxn": {
                        "type": "number",
                        "description": "Actual cost paid in Mexican pesos",
                    },
                    "status": {
                        "type": "string",
                        "enum": ["pending", "in_progress", "completed", "failed"],
                        "description": "New status for the request",
                    },
                    "notes": {
                        "type": "string",
                        "description": "Any notes about the update",
                    },
                },
                "required": ["request_id"],
            },
        ),
        Tool(
            name="archon:mexico_search_afore_funds",
            description="""Search for AFORE retirement funds for someone who worked in the US under a Social Security Number.

Many people don't know they have AFORE funds accumulated! This tool helps:
1. Check if AFORE account exists
2. Estimate potential fund balance
3. Provide steps to recover the money
4. Calculate required documentation

This is especially helpful for people who worked years in the US and are entitled to
retirement funds they never claimed.

Returns information about AFORE account status and recovery process.""",
            inputSchema={
                "type": "object",
                "properties": {
                    "full_name": {
                        "type": "string",
                        "description": "Full legal name (as it appears on official documents)",
                    },
                    "curp": {
                        "type": "string",
                        "description": "CURP (Clave Única de Registro de Población)",
                    },
                    "nss": {
                        "type": "string",
                        "description": "NSS (Número de Seguridad Social) from when they worked",
                    },
                    "date_of_birth": {
                        "type": "string",
                        "description": "Date of birth (YYYY-MM-DD format)",
                    },
                    "years_worked": {
                        "type": "integer",
                        "description": "Approximate number of years worked under NSS",
                    },
                },
                "required": ["full_name", "nss"],
            },
        ),
        Tool(
            name="archon:mexico_auto_fill_form",
            description="""Automatically fill out a Mexican government form with applicant information.

This tool:
1. Gets the form template for the requested document
2. Maps applicant information to form fields
3. Generates a pre-filled form (JSON or PDF data)
4. Provides instructions for submitting

This saves users from manually typing all their information into government forms.""",
            inputSchema={
                "type": "object",
                "properties": {
                    "document_code": {
                        "type": "string",
                        "description": "Document type (e.g., 'licencia', 'pasaporte')",
                    },
                    "applicant_profile_id": {
                        "type": "string",
                        "description": "ID of saved applicant profile (optional)",
                    },
                    "applicant_data": {
                        "type": "object",
                        "description": "Applicant information to fill the form with (if no profile_id)",
                    },
                },
                "required": ["document_code"],
            },
        ),
    ]


async def handle_mexico_list_document_types() -> list[TextContent]:
    """Handle listing all available document types."""
    try:
        # Import here to avoid circular imports
        from ....agents.mexico_document_agent import MEXICO_DOCUMENT_TYPES

        documents = []
        for code, doc in MEXICO_DOCUMENT_TYPES.items():
            documents.append({
                "code": code,
                "name_en": doc.name_en,
                "name_es": doc.name_es,
                "description": doc.description,
                "agency": doc.government_agency,
                "wait_time": doc.typical_wait_time,
                "cost": doc.estimated_cost_mxn,
                "online": doc.online_available,
            })

        return [
            TextContent(
                type="text",
                text=json.dumps({
                    "success": True,
                    "total_documents": len(documents),
                    "documents": documents,
                }, indent=2),
            )
        ]

    except Exception as e:
        logger.error(f"Error listing document types: {e}")
        return [
            TextContent(
                type="text",
                text=json.dumps({"success": False, "error": str(e)}),
            )
        ]


async def handle_mexico_get_document_requirements(
    document_code: str, state: str = ""
) -> list[TextContent]:
    """Handle getting requirements for a specific document."""
    try:
        from ....agents.mexico_document_agent import MEXICO_DOCUMENT_TYPES

        if document_code not in MEXICO_DOCUMENT_TYPES:
            return [
                TextContent(
                    type="text",
                    text=json.dumps({
                        "success": False,
                        "error": f"Unknown document code: {document_code}",
                        "available_codes": list(MEXICO_DOCUMENT_TYPES.keys()),
                    }),
                )
            ]

        doc = MEXICO_DOCUMENT_TYPES[document_code]

        # Check if we have scraped data in database
        supabase = get_supabase_client()
        scraped_result = (
            supabase.table("mexico_scraped_data")
            .select("*")
            .eq("document_code", document_code)
            .order("last_scraped", desc=True)
            .limit(1)
            .execute()
        )

        scraped_data = scraped_result.data[0] if scraped_result.data else None

        response = {
            "success": True,
            "document_code": document_code,
            "name_en": doc.name_en,
            "name_es": doc.name_es,
            "description": doc.description,
            "government_agency": doc.government_agency,
            "typical_wait_time": doc.typical_wait_time,
            "estimated_cost_mxn": doc.estimated_cost_mxn,
            "online_available": doc.online_available,
            "required_documents": doc.required_documents,
        }

        # Add scraped data if available
        if scraped_data:
            response["scraped_info"] = {
                "last_scraped": scraped_data.get("last_scraped"),
                "website_url": scraped_data.get("website_url"),
                "requirements": scraped_data.get("requirements", []),
                "procedures": scraped_data.get("procedures", []),
                "fees": scraped_data.get("fees", {}),
                "processing_times": scraped_data.get("processing_times", {}),
                "office_locations": scraped_data.get("office_locations", []),
                "online_portal_url": scraped_data.get("online_portal_url"),
            }

        return [TextContent(type="text", text=json.dumps(response, indent=2))]

    except Exception as e:
        logger.error(f"Error getting document requirements: {e}")
        return [
            TextContent(
                type="text",
                text=json.dumps({"success": False, "error": str(e)}),
            )
        ]


async def handle_mexico_create_document_request(
    document_codes: list[str],
    applicant_name: str,
    curp: str = "",
    nss: str = "",
    state: str = "",
    user_id: str = "anonymous",
    additional_info: dict = None,
) -> list[TextContent]:
    """Handle creating a new document request."""
    try:
        from ....agents.mexico_document_agent import MEXICO_DOCUMENT_TYPES
        import uuid

        # Validate document codes
        invalid_codes = [code for code in document_codes if code not in MEXICO_DOCUMENT_TYPES]
        if invalid_codes:
            return [
                TextContent(
                    type="text",
                    text=json.dumps({
                        "success": False,
                        "error": f"Invalid document codes: {', '.join(invalid_codes)}",
                        "available_codes": list(MEXICO_DOCUMENT_TYPES.keys()),
                    }),
                )
            ]

        # Generate request ID
        request_id = f"MX-{uuid.uuid4().hex[:8].upper()}"

        # Calculate estimates
        total_cost = 0.0
        max_weeks = 0

        for code in document_codes:
            doc = MEXICO_DOCUMENT_TYPES[code]
            # Parse cost
            cost_str = doc.estimated_cost_mxn.replace(",", "")
            if "-" in cost_str:
                parts = cost_str.split("-")
                try:
                    cost = (float(parts[0]) + float(parts[1])) / 2
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

            # Parse weeks
            wait = doc.typical_wait_time.lower()
            if "week" in wait:
                try:
                    weeks = int(wait.split("-")[-1].split()[0])
                    max_weeks = max(max_weeks, weeks)
                except:
                    max_weeks = max(max_weeks, 4)

        # Create database record
        supabase = get_supabase_client()

        applicant_info = {
            "name": applicant_name,
            "curp": curp,
            "nss": nss,
            "state": state,
        }
        if additional_info:
            applicant_info.update(additional_info)

        next_steps = [
            "Review required documents for each document type",
            "Gather all required identification and documents",
            "Check government websites for latest procedures",
            "Schedule appointments if required",
            "Prepare payment methods",
        ]

        insert_result = supabase.table("mexico_document_requests").insert({
            "user_id": user_id,
            "request_id": request_id,
            "applicant_name": applicant_name,
            "curp": curp,
            "nss": nss,
            "state": state,
            "applicant_info": applicant_info,
            "document_codes": document_codes,
            "status": "pending",
            "next_steps": next_steps,
            "estimated_completion_weeks": max_weeks,
            "estimated_total_cost_mxn": total_cost,
        }).execute()

        if not insert_result.data:
            raise Exception("Failed to create database record")

        return [
            TextContent(
                type="text",
                text=json.dumps({
                    "success": True,
                    "request_id": request_id,
                    "message": f"Successfully created request for {len(document_codes)} document(s)",
                    "documents_requested": [
                        MEXICO_DOCUMENT_TYPES[code].name_en for code in document_codes
                    ],
                    "next_steps": next_steps,
                    "estimated_timeline_weeks": max_weeks,
                    "estimated_total_cost_mxn": total_cost,
                }, indent=2),
            )
        ]

    except Exception as e:
        logger.error(f"Error creating document request: {e}")
        return [
            TextContent(
                type="text",
                text=json.dumps({"success": False, "error": str(e)}),
            )
        ]


async def handle_mexico_get_request_status(request_id: str) -> list[TextContent]:
    """Handle getting request status."""
    try:
        supabase = get_supabase_client()

        result = (
            supabase.table("mexico_document_requests")
            .select("*")
            .eq("request_id", request_id)
            .single()
            .execute()
        )

        if not result.data:
            return [
                TextContent(
                    type="text",
                    text=json.dumps({
                        "success": False,
                        "error": f"Request not found: {request_id}",
                    }),
                )
            ]

        request = result.data

        return [
            TextContent(
                type="text",
                text=json.dumps({
                    "success": True,
                    "request_id": request_id,
                    "status": request["status"],
                    "applicant_name": request["applicant_name"],
                    "documents_requested": request["document_codes"],
                    "steps_completed": request.get("steps_completed", []),
                    "next_steps": request.get("next_steps", []),
                    "documents_obtained": request.get("documents_obtained", []),
                    "estimated_cost_mxn": request.get("estimated_total_cost_mxn"),
                    "actual_cost_mxn": request.get("actual_total_cost_mxn"),
                    "created_at": request["created_at"],
                    "updated_at": request["updated_at"],
                }, indent=2),
            )
        ]

    except Exception as e:
        logger.error(f"Error getting request status: {e}")
        return [
            TextContent(
                type="text",
                text=json.dumps({"success": False, "error": str(e)}),
            )
        ]


# Export the tool handlers
MEXICO_DOCS_TOOL_HANDLERS = {
    "archon:mexico_list_document_types": handle_mexico_list_document_types,
    "archon:mexico_get_document_requirements": handle_mexico_get_document_requirements,
    "archon:mexico_create_document_request": handle_mexico_create_document_request,
    "archon:mexico_get_request_status": handle_mexico_get_request_status,
}
