#!/bin/bash
# Architecture Document Validation Script
# Validates architecture document for completeness and NFR coverage

set -e

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check if file path provided
if [ $# -eq 0 ]; then
    echo "Usage: $0 <path-to-architecture-document>"
    echo ""
    echo "Example:"
    echo "  $0 docs/architecture-myproject-2025-12-09.md"
    exit 1
fi

ARCH_DOC="$1"

# Check if file exists
if [ ! -f "$ARCH_DOC" ]; then
    echo -e "${RED}Error: File not found: $ARCH_DOC${NC}"
    exit 1
fi

echo "================================================================================"
echo "  Architecture Document Validation"
echo "================================================================================"
echo ""
echo "Document: $ARCH_DOC"
echo ""
echo "================================================================================"
echo ""

# Initialize counters
PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0

# Helper function to check for section
check_section() {
    local section_name="$1"
    local search_pattern="$2"
    local required="$3"  # "required" or "optional"

    if grep -qi "$search_pattern" "$ARCH_DOC"; then
        echo -e "${GREEN}[PASS]${NC} $section_name"
        ((PASS_COUNT++))
        return 0
    else
        if [ "$required" = "required" ]; then
            echo -e "${RED}[FAIL]${NC} $section_name - MISSING"
            ((FAIL_COUNT++))
        else
            echo -e "${YELLOW}[WARN]${NC} $section_name - Not found (optional)"
            ((WARN_COUNT++))
        fi
        return 1
    fi
}

# Helper function to check for keyword presence
check_keyword() {
    local description="$1"
    local keyword="$2"
    local required="$3"  # "required" or "optional"

    if grep -qi "$keyword" "$ARCH_DOC"; then
        echo -e "${GREEN}[PASS]${NC} $description"
        ((PASS_COUNT++))
        return 0
    else
        if [ "$required" = "required" ]; then
            echo -e "${RED}[FAIL]${NC} $description - MISSING"
            ((FAIL_COUNT++))
        else
            echo -e "${YELLOW}[WARN]${NC} $description - Not found"
            ((WARN_COUNT++))
        fi
        return 1
    fi
}

echo -e "${BLUE}1. Required Sections${NC}"
echo "-------------------"
check_section "System Overview" "system overview\|overview\|introduction" "required"
check_section "Architecture Pattern" "architecture pattern\|architectural pattern\|pattern" "required"
check_section "Component Design" "component\|components\|modules" "required"
check_section "Data Model" "data model\|database\|data schema" "required"
check_section "API Specifications" "api\|endpoints\|interface" "required"
check_section "NFR Mapping" "nfr\|non-functional requirement" "required"
check_section "Technology Stack" "technology stack\|tech stack\|technologies" "required"
check_section "Trade-off Analysis" "trade-off\|tradeoff\|decisions" "required"
echo ""

echo -e "${BLUE}2. NFR Coverage${NC}"
echo "---------------"
check_keyword "Performance NFRs addressed" "performance\|caching\|response time\|latency" "required"
check_keyword "Scalability NFRs addressed" "scalability\|scaling\|horizontal\|load" "required"
check_keyword "Security NFRs addressed" "security\|authentication\|authorization\|encryption" "required"
check_keyword "Reliability NFRs addressed" "reliability\|redundancy\|failover\|backup" "optional"
check_keyword "Availability NFRs addressed" "availability\|uptime\|monitoring" "optional"
check_keyword "Maintainability addressed" "maintainability\|testing\|documentation\|ci/cd" "optional"
echo ""

echo -e "${BLUE}3. Technical Completeness${NC}"
echo "-------------------------"
check_keyword "Technology choices justified" "rationale\|reason\|because\|chosen\|selected" "required"
check_keyword "Component interfaces defined" "interface\|api\|contract\|endpoint" "required"
check_keyword "Data entities specified" "entity\|entities\|table\|schema\|model" "required"
check_keyword "Deployment described" "deployment\|deploy\|infrastructure\|hosting" "optional"
echo ""

echo -e "${BLUE}4. Architecture Quality${NC}"
echo "-----------------------"
check_keyword "Architectural drivers identified" "driver\|constraint\|requirement\|nfr" "optional"
check_keyword "Alternatives considered" "alternative\|option\|considered\|vs\|versus" "optional"
check_keyword "Trade-offs documented" "trade-off\|tradeoff\|cost\|benefit" "required"
check_keyword "Future considerations" "future\|scalability\|growth\|evolution" "optional"
echo ""

echo -e "${BLUE}5. Specific Architecture Patterns${NC}"
echo "----------------------------------"
# Check which pattern is used (at least one should be mentioned)
PATTERN_FOUND=0
if grep -qi "monolith" "$ARCH_DOC"; then
    echo -e "${GREEN}[INFO]${NC} Pattern: Monolith detected"
    PATTERN_FOUND=1
fi
if grep -qi "microservice" "$ARCH_DOC"; then
    echo -e "${GREEN}[INFO]${NC} Pattern: Microservices detected"
    PATTERN_FOUND=1
fi
if grep -qi "serverless" "$ARCH_DOC"; then
    echo -e "${GREEN}[INFO]${NC} Pattern: Serverless detected"
    PATTERN_FOUND=1
fi
if grep -qi "layered\|layer" "$ARCH_DOC"; then
    echo -e "${GREEN}[INFO]${NC} Pattern: Layered architecture detected"
    PATTERN_FOUND=1
fi

if [ $PATTERN_FOUND -eq 0 ]; then
    echo -e "${RED}[FAIL]${NC} No architectural pattern clearly identified"
    ((FAIL_COUNT++))
else
    echo -e "${GREEN}[PASS]${NC} Architectural pattern identified"
    ((PASS_COUNT++))
fi
echo ""

echo -e "${BLUE}6. Integration Patterns${NC}"
echo "-----------------------"
if grep -qi "rest\|restful\|graphql\|grpc\|message queue\|kafka\|event" "$ARCH_DOC"; then
    echo -e "${GREEN}[PASS]${NC} Integration pattern specified"
    ((PASS_COUNT++))
else
    echo -e "${YELLOW}[WARN]${NC} Integration pattern not clearly specified"
    ((WARN_COUNT++))
fi
echo ""

# Calculate totals
TOTAL_CHECKS=$((PASS_COUNT + FAIL_COUNT))
if [ $TOTAL_CHECKS -gt 0 ]; then
    PASS_RATE=$((PASS_COUNT * 100 / TOTAL_CHECKS))
else
    PASS_RATE=0
fi

echo "================================================================================"
echo "  Validation Results"
echo "================================================================================"
echo ""
echo -e "Passed:   ${GREEN}$PASS_COUNT${NC}"
echo -e "Failed:   ${RED}$FAIL_COUNT${NC}"
echo -e "Warnings: ${YELLOW}$WARN_COUNT${NC}"
echo ""
echo -e "Pass Rate: ${BLUE}${PASS_RATE}%${NC} (${PASS_COUNT}/${TOTAL_CHECKS})"
echo ""

# Final verdict
if [ $FAIL_COUNT -eq 0 ]; then
    echo -e "${GREEN}================================================================================"
    echo "  VALIDATION PASSED"
    echo -e "================================================================================${NC}"
    echo ""
    echo "Architecture document meets completeness requirements."
    if [ $WARN_COUNT -gt 0 ]; then
        echo ""
        echo -e "${YELLOW}Note: $WARN_COUNT optional sections missing. Consider adding for completeness.${NC}"
    fi
    exit 0
else
    echo -e "${RED}================================================================================"
    echo "  VALIDATION FAILED"
    echo -e "================================================================================${NC}"
    echo ""
    echo "Architecture document is incomplete. Address the failed checks above."
    echo ""
    echo "Common fixes:"
    echo "  1. Ensure all required sections are present with clear headings"
    echo "  2. Document NFR mapping explicitly in a table or section"
    echo "  3. Include technology choice rationale for each major decision"
    echo "  4. Document trade-offs for major architectural decisions"
    echo "  5. Specify architectural pattern (monolith, microservices, etc.)"
    echo ""
    echo "Reference the template at:"
    echo "  bmad-skills/system-architect/templates/architecture.template.md"
    echo ""
    exit 1
fi
