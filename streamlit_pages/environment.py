import streamlit as st
import sys
import os

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from utils.utils import (
    get_env_var, save_env_var, reload_archon_graph, 
    get_current_profile, set_current_profile, get_all_profiles,
    create_profile, delete_profile, get_profile_env_vars
)

def environment_tab():    
    # Get all available profiles and current profile
    profiles = get_all_profiles()
    current_profile = get_current_profile()
    
    # Profile management section
    st.subheader("Profile Management")
    st.write("Profiles allow you to store different sets of environment variables for different providers or use cases.")
    
    col1, col2 = st.columns([3, 1])
    
    with col1:
        # Profile selector
        selected_profile = st.selectbox(
            "Select Profile", 
            options=profiles,
            index=profiles.index(current_profile) if current_profile in profiles else 0,
            key="profile_selector"
        )
        
        if selected_profile != current_profile:
            if set_current_profile(selected_profile):
                st.success(f"Switched to profile: {selected_profile}, reloading...")
                reload_archon_graph(show_reload_success=False)
                st.rerun()
            else:
                st.error("Failed to switch profile.")
    
    with col2:
        # Add CSS for precise margin control
        st.markdown("""
            <style>
            div[data-testid="stChatInput"] {
                margin-top: 10px !important;
            }
            </style>
        """, unsafe_allow_html=True)
        
        # New profile creation with CSS applied directly to the chat input
        new_profile_name = st.chat_input("New Profile Name", key="new_profile_name")
        
        # Add a button to create the profile
        if new_profile_name:
            if new_profile_name in profiles:
                st.error(f"Profile '{new_profile_name}' already exists.")
            else:
                if create_profile(new_profile_name):
                    st.success(f"Created profile: {new_profile_name}")
                    st.rerun()
                else:
                    st.error("Failed to create profile.")
    
    # Delete profile option (not for default)
    if selected_profile != "default" and selected_profile == current_profile:
        if st.button("Delete Current Profile", key="delete_profile"):
            if delete_profile(selected_profile):
                st.success(f"Deleted profile: {selected_profile}, reloading...")
                reload_archon_graph(show_reload_success=False)
                st.rerun()
            else:
                st.error("Failed to delete profile.")
    
    st.markdown("---")
    
    # Environment variables section
    st.subheader(f"Environment Variables for Profile: {current_profile}")
    st.write("- Configure your environment variables for Archon. These settings will be saved and used for future sessions.")
    st.write("- NOTE: Press 'enter' to save after inputting a variable, otherwise click the 'save' button at the bottom.")
    st.write("- HELP: Hover over the '?' icon on the right for each environment variable for help/examples.")
    st.warning("⚠️ If your agent service for MCP is already running, you'll need to restart it after changing environment variables.")

    # Get current profile's environment variables
    profile_env_vars = get_profile_env_vars()
    # Define default URLs for providers
    llm_default_urls = {
        "OpenAI": "https://api.openai.com/v1",
        "AzureOpenAI": "https://api.openai.azure.com",
        "Anthropic": "https://api.anthropic.com/v1",
        "OpenRouter": "https://openrouter.ai/api/v1",
        "Ollama": "http://localhost:11434/v1"
    }
    
    embedding_default_urls = {
        "OpenAI": "https://api.openai.com/v1",
        "AzureOpenAI": "https://api.openai.azure.com",
        "Ollama": "http://localhost:11434/v1"
    }
    
    # Initialize session state for provider selections if not already set
    if "llm_provider" not in st.session_state:
        st.session_state.llm_provider = profile_env_vars.get("LLM_PROVIDER", "OpenAI")

    if "reasoning_llm_provider" not in st.session_state:
        st.session_state.reasoning_llm_provider = profile_env_vars.get("Reasoning_LLM_PROVIDER", "OpenAI")
    
    if "embedding_provider" not in st.session_state:
        st.session_state.embedding_provider = profile_env_vars.get("EMBEDDING_PROVIDER", "OpenAI")
    
    # 1. Large Language Models Section - Provider Selection (outside form)
    st.subheader("1. Select Your LLM Provider")
    
    # LLM Provider dropdown
    llm_providers = ["OpenAI", "AzureOpenAI", "Anthropic", "OpenRouter", "Ollama"]
    selected_llm_provider = st.selectbox(
        "LLM Provider",
        options=llm_providers,
        index=llm_providers.index(st.session_state.llm_provider) if st.session_state.llm_provider in llm_providers else 0,
        key="llm_provider_selector"
    )
    
    # Update session state if provider changed
    if selected_llm_provider != st.session_state.llm_provider:
        st.session_state.llm_provider = selected_llm_provider
        st.rerun()  # Force a rerun to update the form

    # 1. Large Language Models Section - Provider Selection (outside form)
    st.subheader("2. Select Your Reasoning LLM Provider")
    
    # LLM Provider dropdown
    reasoning_llm_providers = ["OpenAI", "AzureOpenAI", "Anthropic", "OpenRouter", "Ollama"]
    selected_reasoning_llm_provider = st.selectbox(
        "Reasoning_LLM Provider",
        options=reasoning_llm_providers,
        index=llm_providers.index(st.session_state.reasoning_llm_provider) if st.session_state.reasoning_llm_provider in reasoning_llm_providers else 0,
        key="reasoning_llm_provider_selector"
    )
    
    # Update session state if provider changed
    if selected_reasoning_llm_provider != st.session_state.reasoning_llm_provider:
        st.session_state.reasoning_llm_provider = selected_reasoning_llm_provider
        st.rerun()  # Force a rerun to update the form
    
    # 2. Embedding Models Section - Provider Selection (outside form)
    st.subheader("3. Select Your Embedding Model Provider")
    
    # Embedding Provider dropdown
    embedding_providers = ["OpenAI", "AzureOpenAI", "Ollama"]
    
    selected_embedding_provider = st.selectbox(
        "Embedding Provider",
        options=embedding_providers,
        index=embedding_providers.index(st.session_state.embedding_provider) if st.session_state.embedding_provider in embedding_providers else 0,
        key="embedding_provider_selector"
    )
    
    # Update session state if provider changed
    if selected_embedding_provider != st.session_state.embedding_provider:
        st.session_state.embedding_provider = selected_embedding_provider
        st.rerun()  # Force a rerun to update the form

    # 3. Set environment variables (within the form)
    st.subheader("4. Set All Environment Variables")        
    
    # Create a form for the environment variables
    with st.form("env_vars_form"):
        updated_values = {}
        
        # Store the selected providers in the updated values
        updated_values["LLM_PROVIDER"] = selected_llm_provider
        updated_values["Reasoning_LLM_PROVIDER"] = selected_reasoning_llm_provider
        updated_values["EMBEDDING_PROVIDER"] = selected_embedding_provider
        
        # 1. Large Language Models Section - Settings
        st.subheader("Primary LLM Settings")
        
        # BASE_URL
        base_url_help = "Base URL for your LLM provider:\n\n" + \
                        "OpenAI: https://api.openai.com/v1\n\n" + \
                        "Anthropic: https://api.anthropic.com/v1\n\n" + \
                        "OpenRouter: https://openrouter.ai/api/v1\n\n" + \
                        "Ollama: http://localhost:11434/v1"
        
        # Get current BASE_URL or use default for selected provider
        current_base_url = profile_env_vars.get("BASE_URL", llm_default_urls.get(selected_llm_provider, ""))
        
        # If provider changed or BASE_URL is empty, use the default
        if not current_base_url or profile_env_vars.get("LLM_PROVIDER", "") != selected_llm_provider:
            current_base_url = llm_default_urls.get(selected_llm_provider, "")
        
        llm_base_url = st.text_input(
            "BASE_URL:",
            value=current_base_url,
            help=base_url_help,
            key="input_BASE_URL"
        )
        updated_values["BASE_URL"] = llm_base_url
        
        # API_KEY
        api_key_help = "API key for your LLM provider:\n\n" + \
                       "For OpenAI: https://help.openai.com/en/articles/4936850-where-do-i-find-my-openai-api-key\n\n" + \
                       "For Anthropic: https://console.anthropic.com/account/keys\n\n" + \
                       "For OpenRouter: https://openrouter.ai/keys\n\n" + \
                       "For Ollama, no need to set this unless you specifically configured an API key"
        
        # Get current API_KEY or set default for Ollama
        current_api_key = profile_env_vars.get("LLM_API_KEY", "")
        
        # If provider is Ollama and LLM_API_KEY is empty or provider changed, set to NOT_REQUIRED
        if selected_llm_provider == "Ollama" and (not current_api_key or profile_env_vars.get("LLM_PROVIDER", "") != selected_llm_provider):
            current_api_key = "NOT_REQUIRED"
        
        # If there's already a value, show asterisks in the placeholder
        placeholder = current_api_key if current_api_key == "NOT_REQUIRED" else "Set but hidden" if current_api_key else ""
        api_key = st.text_input(
            "API_KEY:",
            type="password" if current_api_key != "NOT_REQUIRED" else "default",
            help=api_key_help,
            key="input_LLM_API_KEY",
            placeholder=placeholder
        )
        # Only update if user entered something (to avoid overwriting with empty string)
        if api_key:
            updated_values["LLM_API_KEY"] = api_key
        elif selected_llm_provider == "Ollama" and (not current_api_key or current_api_key == "NOT_REQUIRED"):
            updated_values["LLM_API_KEY"] = "NOT_REQUIRED"
        
        # API VERSION
        api_version_help = "API version for your LLM provider:\n\n" + \
                        "For OpenAI: Refer to https://platform.openai.com/docs/models for the latest supported versions.\n\n" + \
                        "For Anthropic: API versions are managed automatically; check https://docs.anthropic.com/claude/docs for details.\n\n" + \
                        "For OpenRouter: OpenRouter does not require an API version; it handles model updates automatically.\n\n" + \
                        "For Azure OpenAI: Set this to the appropriate version from https://learn.microsoft.com/en-us/azure/cognitive-services/openai/release-notes."


        if selected_llm_provider=="AzureOpenAI":
            current_api_version = profile_env_vars.get("LLM_API_VERSION", "")
            api_version = st.text_input(
                "API_VERSION:",
                value=current_api_version,
                help=api_version_help,
                key="input_API_VERSION"
            )
            updated_values["LLM_API_VERSION"] = api_version

        # PRIMARY_MODEL
        primary_model_help = "The LLM you want to use for the primary agent/coder\n\n" + \
                            "Example: gpt-4o-mini\n\n" + \
                            "Example: qwen2.5:14b-instruct-8k"
        
        primary_model = st.text_input(
            "PRIMARY_MODEL:",
            value=profile_env_vars.get("PRIMARY_MODEL", ""),
            help=primary_model_help,
            key="input_PRIMARY_MODEL"
        )
        updated_values["PRIMARY_MODEL"] = primary_model
        
        st.subheader("Reasoning LLM Settings")
        # BASE_URL
        base_url_help = "Base URL for your LLM provider:\n\n" + \
                        "OpenAI: https://api.openai.com/v1\n\n" + \
                        "Anthropic: https://api.anthropic.com/v1\n\n" + \
                        "OpenRouter: https://openrouter.ai/api/v1\n\n" + \
                        "Ollama: http://localhost:11434/v1"
        
        # Get current BASE_URL or use default for selected provider
        current_reasoning_base_url = profile_env_vars.get("Reasoning_BASE_URL", llm_default_urls.get(selected_reasoning_llm_provider, ""))
        
        # If provider changed or BASE_URL is empty, use the default
        if not current_reasoning_base_url or profile_env_vars.get("Reasoning_LLM_PROVIDER", "") != selected_reasoning_llm_provider:
            current_reasoning_base_url = llm_default_urls.get(selected_reasoning_llm_provider, "")
        
        llm_reasoning_base_url = st.text_input(
            "Reasoning_BASE_URL:",
            value=current_reasoning_base_url,
            help=base_url_help,
            key="input_Reasoning_BASE_URL"
        )
        updated_values["Reasoning_BASE_URL"] = llm_reasoning_base_url
        
        # API_KEY
        api_key_help = "API key for your LLM provider:\n\n" + \
                       "For OpenAI: https://help.openai.com/en/articles/4936850-where-do-i-find-my-openai-api-key\n\n" + \
                       "For Anthropic: https://console.anthropic.com/account/keys\n\n" + \
                       "For OpenRouter: https://openrouter.ai/keys\n\n" + \
                       "For Ollama, no need to set this unless you specifically configured an API key"
        
        # Get current API_KEY or set default for Ollama
        current_reasoning_api_key = profile_env_vars.get("Reasoning_LLM_API_KEY", "")
        
        # If provider is Ollama and LLM_API_KEY is empty or provider changed, set to NOT_REQUIRED
        if selected_reasoning_llm_provider == "Ollama" and (not current_reasoning_api_key or profile_env_vars.get("Reasoning_LLM_PROVIDER", "") != selected_reasoning_llm_provider):
            current_reasoning_api_key = "NOT_REQUIRED"
        
        # If there's already a value, show asterisks in the placeholder
        placeholder = current_reasoning_api_key if current_reasoning_api_key == "NOT_REQUIRED" else "Set but hidden" if current_reasoning_api_key else ""
        reasoning_api_key = st.text_input(
            "Reasoning_API_KEY:",
            type="password" if current_reasoning_api_key != "NOT_REQUIRED" else "default",
            help=api_key_help,
            key="input_ReasoningLLM_API_KEY",
            placeholder=placeholder
        )
        # Only update if user entered something (to avoid overwriting with empty string)
        if reasoning_api_key:
            updated_values["Reasoning_LLM_API_KEY"] = reasoning_api_key
        elif selected_reasoning_llm_provider == "Ollama" and (not current_reasoning_api_key or current_reasoning_api_key == "NOT_REQUIRED"):
            updated_values["Reasoning_LLM_API_KEY"] = "NOT_REQUIRED"
        
        # API VERSION
        api_version_help = "API version for your LLM provider:\n\n" + \
                        "For OpenAI: Refer to https://platform.openai.com/docs/models for the latest supported versions.\n\n" + \
                        "For Anthropic: API versions are managed automatically; check https://docs.anthropic.com/claude/docs for details.\n\n" + \
                        "For OpenRouter: OpenRouter does not require an API version; it handles model updates automatically.\n\n" + \
                        "For Azure OpenAI: Set this to the appropriate version from https://learn.microsoft.com/en-us/azure/cognitive-services/openai/release-notes."


        if selected_reasoning_llm_provider=="AzureOpenAI":
            current_reasoning_api_version = profile_env_vars.get("Reasoning_LLM_API_VERSION", "")
            reasoning_api_version = st.text_input(
                "Reasoning_API_VERSION:",
                value=current_reasoning_api_version,
                help=api_version_help,
                key="input_Reasoning_API_VERSION"
            )
            updated_values["Reasoning_LLM_API_VERSION"] = reasoning_api_version

        # REASONER_MODEL
        reasoner_model_help = "The LLM you want to use for the reasoner\n\n" + \
                             "Example: o3-mini\n\n" + \
                             "Example: deepseek-r1:7b-8k"
        
        reasoner_model = st.text_input(
            "REASONER_MODEL:",
            value=profile_env_vars.get("REASONER_MODEL", ""),
            help=reasoner_model_help,
            key="input_REASONER_MODEL"
        )
        updated_values["REASONER_MODEL"] = reasoner_model
        
        st.markdown("---")
        
        # 2. Embedding Models Section - Settings
        st.subheader("Embedding Settings")
        
        # EMBEDDING_BASE_URL
        embedding_base_url_help = "Base URL for your embedding provider:\n\n" + \
                                 "OpenAI: https://api.openai.com/v1\n\n" + \
                                 "Ollama: http://localhost:11434/v1"
        
        # Get current EMBEDDING_BASE_URL or use default for selected provider
        current_embedding_base_url = profile_env_vars.get("EMBEDDING_BASE_URL", embedding_default_urls.get(selected_embedding_provider, ""))
        
        # If provider changed or EMBEDDING_BASE_URL is empty, use the default
        if not current_embedding_base_url or profile_env_vars.get("EMBEDDING_PROVIDER", "") != selected_embedding_provider:
            current_embedding_base_url = embedding_default_urls.get(selected_embedding_provider, "")
        
        embedding_base_url = st.text_input(
            "EMBEDDING_BASE_URL:",
            value=current_embedding_base_url,
            help=embedding_base_url_help,
            key="input_EMBEDDING_BASE_URL"
        )
        updated_values["EMBEDDING_BASE_URL"] = embedding_base_url
        
        # EMBEDDING_API_KEY
        embedding_api_key_help = "API key for your embedding provider:\n\n" + \
                                "For OpenAI: https://help.openai.com/en/articles/4936850-where-do-i-find-my-openai-api-key\n\n" + \
                                "For Ollama, no need to set this unless you specifically configured an API key"
        
        # Get current EMBEDDING_API_KEY or set default for Ollama
        current_embedding_api_key = profile_env_vars.get("EMBEDDING_API_KEY", "")
        
        # If provider is Ollama and EMBEDDING_API_KEY is empty or provider changed, set to NOT_REQUIRED
        if selected_embedding_provider == "Ollama" and (not current_embedding_api_key or profile_env_vars.get("EMBEDDING_PROVIDER", "") != selected_embedding_provider):
            current_embedding_api_key = "NOT_REQUIRED"
        
        # If there's already a value, show asterisks in the placeholder
        placeholder = "Set but hidden" if current_embedding_api_key else ""
        embedding_api_key = st.text_input(
            "EMBEDDING_API_KEY:",
            type="password",
            help=embedding_api_key_help,
            key="input_EMBEDDING_API_KEY",
            placeholder=placeholder
        )
        # Only update if user entered something (to avoid overwriting with empty string)
        if embedding_api_key:
            updated_values["EMBEDDING_API_KEY"] = embedding_api_key
        elif selected_embedding_provider == "Ollama" and (not current_embedding_api_key or current_embedding_api_key == "NOT_REQUIRED"):
            updated_values["EMBEDDING_API_KEY"] = "NOT_REQUIRED"
        
        # EMBEDDING_MODEL
        embedding_model_help = "Embedding model you want to use\n\n" + \
                              "Example for Ollama: nomic-embed-text\n\n" + \
                              "Example for OpenAI: text-embedding-3-small"
        
        embedding_model = st.text_input(
            "EMBEDDING_MODEL:",
            value=profile_env_vars.get("EMBEDDING_MODEL", ""),
            help=embedding_model_help,
            key="input_EMBEDDING_MODEL"
        )
        updated_values["EMBEDDING_MODEL"] = embedding_model

        # API VERSION
        api_version_help = "API version for your LLM provider:\n\n" + \
                        "For OpenAI: Refer to https://platform.openai.com/docs/models for the latest supported versions.\n\n" + \
                        "For Anthropic: API versions are managed automatically; check https://docs.anthropic.com/claude/docs for details.\n\n" + \
                        "For OpenRouter: OpenRouter does not require an API version; it handles model updates automatically.\n\n" + \
                        "For Azure OpenAI: Set this to the appropriate version from https://learn.microsoft.com/en-us/azure/cognitive-services/openai/release-notes."


        if selected_embedding_provider=="AzureOpenAI":
            current_embedding_api_version = profile_env_vars.get("EMBEDDING_API_VERSION", "")
            embedding_api_version = st.text_input(
                "EMBEDDING_API_VERSION:",
                value=current_embedding_api_version,
                help=api_version_help,
                key="input_embedding_API_VERSION"
            )
            updated_values["EMBEDDING_API_VERSION"] = embedding_api_version
        
        st.markdown("---")
        
        # 3. Database Section
        st.header("3. Database")
        
        # SUPABASE_URL
        supabase_url_help = "Get your SUPABASE_URL from the API section of your Supabase project settings -\nhttps://supabase.com/dashboard/project/<your project ID>/settings/api"
        
        supabase_url = st.text_input(
            "SUPABASE_URL:",
            value=profile_env_vars.get("SUPABASE_URL", ""),
            help=supabase_url_help,
            key="input_SUPABASE_URL"
        )
        updated_values["SUPABASE_URL"] = supabase_url
        
        # SUPABASE_SERVICE_KEY
        supabase_key_help = "Get your SUPABASE_SERVICE_KEY from the API section of your Supabase project settings -\nhttps://supabase.com/dashboard/project/<your project ID>/settings/api\nOn this page it is called the service_role secret."
        
        # If there's already a value, show asterisks in the placeholder
        placeholder = "Set but hidden" if profile_env_vars.get("SUPABASE_SERVICE_KEY", "") else ""
        supabase_key = st.text_input(
            "SUPABASE_SERVICE_KEY:",
            type="password",
            help=supabase_key_help,
            key="input_SUPABASE_SERVICE_KEY",
            placeholder=placeholder
        )
        # Only update if user entered something (to avoid overwriting with empty string)
        if supabase_key:
            updated_values["SUPABASE_SERVICE_KEY"] = supabase_key
        
        # Submit button
        submitted = st.form_submit_button("Save Environment Variables")
        
        if submitted:
            # Save all updated values to the current profile
            success = True
            for var_name, value in updated_values.items():
                if value or var_name in ["LLM_API_KEY", "EMBEDDING_API_KEY"]:  # Allow empty strings for API keys (they might be intentionally cleared)
                    if not save_env_var(var_name, value):
                        success = False
                        st.error(f"Failed to save {var_name}.")
            
            if success:
                st.success(f"Environment variables saved successfully to profile: {current_profile}!")
                reload_archon_graph()