import streamlit as st
import time
import sys
import os
import asyncio
from typing import Optional

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from archon.crawl_pydantic_ai_docs import start_crawl_with_requests, clear_existing_records
from utils.utils import get_env_var, create_new_tab_button
from archon.domain import ISitePagesRepository

def documentation_tab(supabase_client, repository: Optional[ISitePagesRepository] = None):
    """Display the documentation interface

    Args:
        supabase_client: Supabase client (for backward compatibility)
        repository: Optional ISitePagesRepository implementation (new pattern)
    """
    st.header("Documentation")
    
    # Create tabs for different documentation sources
    doc_tabs = st.tabs(["Pydantic AI Docs", "Future Sources"])
    
    with doc_tabs[0]:
        st.subheader("Pydantic AI Documentation")
        st.markdown("""
        This section allows you to crawl and index the Pydantic AI documentation.
        The crawler will:
        
        1. Fetch URLs from the Pydantic AI sitemap
        2. Crawl each page and extract content
        3. Split content into chunks
        4. Generate embeddings for each chunk
        5. Store the chunks in the Supabase database
        
        This process may take several minutes depending on the number of pages.
        """)
        
        # Check if the database is configured
        supabase_url = get_env_var("SUPABASE_URL")
        supabase_key = get_env_var("SUPABASE_SERVICE_KEY")
        
        if not supabase_url or not supabase_key:
            st.warning("⚠️ Supabase is not configured. Please set up your environment variables first.")
            create_new_tab_button("Go to Environment Section", "Environment", key="goto_env_from_docs")
        else:
            # Initialize session state for tracking crawl progress
            if "crawl_tracker" not in st.session_state:
                st.session_state.crawl_tracker = None
            
            if "crawl_status" not in st.session_state:
                st.session_state.crawl_status = None
                
            if "last_update_time" not in st.session_state:
                st.session_state.last_update_time = time.time()
            
            # Create columns for the buttons
            col1, col2 = st.columns(2)
            
            with col1:
                # Button to start crawling
                if st.button("Crawl Pydantic AI Docs", key="crawl_pydantic") and not (st.session_state.crawl_tracker and st.session_state.crawl_tracker.is_running):
                    try:
                        # Define a callback function to update the session state
                        def update_progress(status):
                            st.session_state.crawl_status = status
                        
                        # Start the crawling process in a separate thread
                        st.session_state.crawl_tracker = start_crawl_with_requests(update_progress)
                        st.session_state.crawl_status = st.session_state.crawl_tracker.get_status()
                        
                        # Force a rerun to start showing progress
                        st.rerun()
                    except Exception as e:
                        st.error(f"❌ Error starting crawl: {str(e)}")
            
            with col2:
                # Button to clear existing Pydantic AI docs
                if st.button("Clear Pydantic AI Docs", key="clear_pydantic"):
                    with st.spinner("Clearing existing Pydantic AI docs..."):
                        try:
                            # Run the function to clear records
                            clear_existing_records()
                            st.success("✅ Successfully cleared existing Pydantic AI docs from the database.")
                            
                            # Force a rerun to update the UI
                            st.rerun()
                        except Exception as e:
                            st.error(f"❌ Error clearing Pydantic AI docs: {str(e)}")
            
            # Display crawling progress if a crawl is in progress or has completed
            if st.session_state.crawl_tracker:
                # Create a container for the progress information
                progress_container = st.container()
                
                with progress_container:
                    # Get the latest status
                    current_time = time.time()
                    # Update status every second
                    if current_time - st.session_state.last_update_time >= 1:
                        st.session_state.crawl_status = st.session_state.crawl_tracker.get_status()
                        st.session_state.last_update_time = current_time
                    
                    status = st.session_state.crawl_status
                    
                    # Display a progress bar
                    if status and status["urls_found"] > 0:
                        progress = status["urls_processed"] / status["urls_found"]
                        st.progress(progress)
                    
                    # Display status metrics
                    col1, col2, col3, col4 = st.columns(4)
                    if status:
                        col1.metric("URLs Found", status["urls_found"])
                        col2.metric("URLs Processed", status["urls_processed"])
                        col3.metric("Successful", status["urls_succeeded"])
                        col4.metric("Failed", status["urls_failed"])
                    else:
                        col1.metric("URLs Found", 0)
                        col2.metric("URLs Processed", 0)
                        col3.metric("Successful", 0)
                        col4.metric("Failed", 0)
                    
                    # Display logs in an expander
                    with st.expander("Crawling Logs", expanded=True):
                        if status and "logs" in status:
                            logs_text = "\n".join(status["logs"][-20:])  # Show last 20 logs
                            st.code(logs_text)
                        else:
                            st.code("No logs available yet...")
                    
                    # Show completion message
                    if status and not status["is_running"] and status["end_time"]:
                        if status["urls_failed"] == 0:
                            st.success("✅ Crawling process completed successfully!")
                        else:
                            st.warning(f"⚠️ Crawling process completed with {status['urls_failed']} failed URLs.")
                
                # Auto-refresh while crawling is in progress
                if not status or status["is_running"]:
                    st.rerun()
        
        # Display database statistics
        st.subheader("Database Statistics")
        try:
            # Migration P3-06a & P3-06b: Use repository if available, fallback to Supabase
            if repository is not None:
                # New pattern: Use repository
                try:
                    # P3-06a: Count records for pydantic_ai_docs source
                    count = asyncio.run(repository.count(source="pydantic_ai_docs"))

                    # Display the count
                    st.metric("Pydantic AI Docs Chunks", count)

                    # P3-06b: Sample data - repository doesn't have a generic "list/sample" method
                    # Fall back to Supabase for viewing data (UI-specific feature)
                    if count > 0 and st.button("View Indexed Data", key="view_pydantic_data"):
                        # Note: This is a UI feature not covered by repository interface
                        sample_data = supabase_client.table("site_pages").select("url,title,summary,chunk_number").eq("metadata->>source", "pydantic_ai_docs").limit(10).execute()

                        # Display the sample data
                        st.dataframe(sample_data.data)
                        st.info("Showing up to 10 sample records. The database contains more records.")

                except Exception as repo_error:
                    # If repository fails, fallback to full Supabase
                    st.warning(f"Repository query failed, using Supabase fallback: {str(repo_error)}")
                    result = supabase_client.table("site_pages").select("count", count="exact").eq("metadata->>source", "pydantic_ai_docs").execute()
                    count = result.count if hasattr(result, "count") else 0
                    st.metric("Pydantic AI Docs Chunks", count)

                    if count > 0 and st.button("View Indexed Data", key="view_pydantic_data"):
                        sample_data = supabase_client.table("site_pages").select("url,title,summary,chunk_number").eq("metadata->>source", "pydantic_ai_docs").limit(10).execute()
                        st.dataframe(sample_data.data)
                        st.info("Showing up to 10 sample records. The database contains more records.")
            else:
                # Fallback: Old Supabase pattern
                result = supabase_client.table("site_pages").select("count", count="exact").eq("metadata->>source", "pydantic_ai_docs").execute()
                count = result.count if hasattr(result, "count") else 0

                # Display the count
                st.metric("Pydantic AI Docs Chunks", count)

                # Add a button to view the data
                if count > 0 and st.button("View Indexed Data", key="view_pydantic_data"):
                    # Query a sample of the data
                    sample_data = supabase_client.table("site_pages").select("url,title,summary,chunk_number").eq("metadata->>source", "pydantic_ai_docs").limit(10).execute()

                    # Display the sample data
                    st.dataframe(sample_data.data)
                    st.info("Showing up to 10 sample records. The database contains more records.")
        except Exception as e:
            st.error(f"Error querying database: {str(e)}")
    
    with doc_tabs[1]:
        st.info("Additional documentation sources will be available in future updates.")