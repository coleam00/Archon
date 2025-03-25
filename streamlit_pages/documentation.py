import streamlit as st
import time
import sys
import os
import re

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from archon.documentation_crawler import DocumentationSource, DocumentationCrawler, registry, get_sitemap_urls
from utils.utils import get_env_var, create_new_tab_button

def documentation_tab(supabase_client):
    """Display the documentation interface"""
    st.header("Documentation")
    
    # Check if the database is configured
    supabase_url = get_env_var("SUPABASE_URL")
    supabase_key = get_env_var("SUPABASE_SERVICE_KEY")
    
    if not supabase_url or not supabase_key:
        st.warning("⚠️ Supabase is not configured. Please set up your environment variables first.")
        create_new_tab_button("Go to Environment Section", "Environment", key="goto_env_from_docs")
        return
    
    # Get all registered sources
    all_sources = registry.get_all_sources()
    
    # Create tabs dynamically for all sources + an "Add Source" tab
    source_tabs = st.tabs([source.name for source in all_sources] + ["Add Source"])
    
    # Loop through each source and display its tab content
    for idx, (source, tab) in enumerate(zip(all_sources, source_tabs[:-1])):
        source_id = source.id
        with tab:
            # Initialize session state for this source if needed
            if f"crawl_tracker_{source_id}" not in st.session_state:
                st.session_state[f"crawl_tracker_{source_id}"] = None
            if f"crawl_status_{source_id}" not in st.session_state:
                st.session_state[f"crawl_status_{source_id}"] = None
            if f"last_update_time_{source_id}" not in st.session_state:
                st.session_state[f"last_update_time_{source_id}"] = time.time()
            
            # Display source info
            st.subheader(f"{source.name} Documentation")
            st.markdown(source.description)
            
            # Create columns for the buttons
            col1, col2 = st.columns(2)
            
            with col1:
                # Button to start crawling
                if st.button(f"Crawl {source.name}", key=f"crawl_{source_id}") and not (st.session_state[f"crawl_tracker_{source_id}"] and st.session_state[f"crawl_tracker_{source_id}"].is_running):
                    try:
                        # Define a callback function to update the session state
                        def update_progress(status):
                            st.session_state[f"crawl_status_{source_id}"] = status
                        
                        # Get a crawler for this source
                        crawler = DocumentationCrawler(source)
                        
                        # Start the crawling process in a separate thread
                        st.session_state[f"crawl_tracker_{source_id}"] = crawler.start_crawler(update_progress)
                        st.session_state[f"crawl_status_{source_id}"] = st.session_state[f"crawl_tracker_{source_id}"].get_status()
                        
                        # Force a rerun to start showing progress
                        st.rerun()
                    except Exception as e:
                        st.error(f"❌ Error starting crawl: {str(e)}")
            
            with col2:
                # Button to clear existing docs
                if st.button(f"Clear {source.name}", key=f"clear_{source_id}"):
                    with st.spinner(f"Clearing existing {source.name}..."):
                        try:
                            # Get a crawler for this source and clear records
                            crawler = DocumentationCrawler(source)
                            crawler.clear_existing_records()
                            st.success(f"✅ Successfully cleared existing {source.name} from the database.")
                            
                            # Force a rerun to update the UI
                            st.rerun()
                        except Exception as e:
                            st.error(f"❌ Error clearing {source.name}: {str(e)}")
            
            # Display crawling progress if a crawl is in progress or has completed
            if st.session_state[f"crawl_tracker_{source_id}"]:
                # Create a container for the progress information
                progress_container = st.container()
                
                with progress_container:
                    # Get the latest status
                    current_time = time.time()
                    # Update status every second
                    if current_time - st.session_state[f"last_update_time_{source_id}"] >= 1:
                        st.session_state[f"crawl_status_{source_id}"] = st.session_state[f"crawl_tracker_{source_id}"].get_status()
                        st.session_state[f"last_update_time_{source_id}"] = current_time
                    
                    status = st.session_state[f"crawl_status_{source_id}"]
                    
                    # Display a progress bar
                    if status and status["urls_found"] > 0:
                        progress = status["urls_processed"] / status["urls_found"]
                        st.progress(progress)
                    
                    # Display status metrics
                    col1, col2, col3, col4, col5 = st.columns(5)
                    if status:
                        col1.metric("URLs Found", status["urls_found"])
                        col2.metric("URLs Processed", status["urls_processed"])
                        col3.metric("Successful", status["urls_succeeded"])
                        col4.metric("Failed", status["urls_failed"])
                        col5.metric("Chunks Stored", status.get("chunks_stored", 0))
                    else:
                        col1.metric("URLs Found", 0)
                        col2.metric("URLs Processed", 0)
                        col3.metric("Successful", 0)
                        col4.metric("Failed", 0)
                        col5.metric("Chunks Stored", 0)
                    
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
                            st.success(f"✅ Crawling process for {source.name} completed successfully!")
                        else:
                            st.warning(f"⚠️ Crawling process for {source.name} completed with {status['urls_failed']} failed URLs.")
                
                # Auto-refresh while crawling is in progress
                if not status or status["is_running"]:
                    st.rerun()
            
            # Display database statistics
            st.subheader("Database Statistics")
            try:            
                # Query the count of docs for this source
                result = supabase_client.table("site_pages").select("count", count="exact").eq("metadata->>source", source_id).execute()
                count = result.count if hasattr(result, "count") else 0
                
                # Display the count
                st.metric(f"{source.name} Chunks", count)
                
                # Add a button to view the data
                if count > 0 and st.button(f"View Indexed Data", key=f"view_{source_id}"):
                    # Query a sample of the data
                    sample_data = supabase_client.table("site_pages").select("url,title,summary,chunk_number").eq("metadata->>source", source_id).limit(10).execute()
                    
                    # Display the sample data
                    st.dataframe(sample_data.data)
                    st.info("Showing up to 10 sample records. The database contains more records.")
            except Exception as e:
                st.error(f"Error querying database: {str(e)}")
    
    # "Add Source" tab for adding new sources
    with source_tabs[-1]:
        st.subheader("Add a New Documentation Source")
        st.markdown("Enter information about a new documentation source to add it to the registry.")
        
        # Form for adding a new source
        with st.form("add_source_form"):
            # Source name
            source_name = st.text_input("Source Name", placeholder="e.g., FastAPI Docs")
            
            # Source description
            source_description = st.text_area("Source Description", 
                                  placeholder="e.g., FastAPI is a modern, fast web framework for building APIs with Python.")
            
            # Sitemap URL
            sitemap_url = st.text_input("Sitemap URL", placeholder="e.g., https://fastapi.tiangolo.com/sitemap.xml")
            
            # Submit button
            submitted = st.form_submit_button("Add Source")
            
            if submitted:
                if not source_name or not sitemap_url:
                    st.error("Source name and sitemap URL are required!")
                else:
                    # Create a source ID from the name
                    source_id = re.sub(r'[^a-z0-9_]', '_', source_name.lower())
                    
                    # Check if the ID is already used
                    if any(s.id == source_id for s in all_sources):
                        st.error(f"A source with ID '{source_id}' already exists. Please use a different name.")
                    else:
                        try:
                            # Test fetching URLs from the sitemap
                            urls = get_sitemap_urls(sitemap_url)
                            
                            if not urls:
                                st.error(f"Could not fetch any URLs from the sitemap at {sitemap_url}")
                            else:
                                # Create a new source
                                new_source = DocumentationSource(
                                    id=source_id,
                                    name=source_name,
                                    description=source_description or f"{source_name} documentation",
                                    url_fetcher=lambda sitemap=sitemap_url: get_sitemap_urls(sitemap),
                                    sitemap_url=sitemap_url
                                )
                                
                                # Register the source
                                registry.register(new_source)
                                
                                st.success(f"Successfully added {source_name} as a new documentation source!")
                                st.info("Refresh the page to see the new source in the documentation tabs.")
                                
                                if st.button("Refresh Now"):
                                    st.rerun()
                        except Exception as e:
                            st.error(f"Error adding source: {str(e)}")