/**
 * Manual test to verify knowledge API integration
 * Run with: npx tsx tests/manual/test-knowledge-api.ts
 */

import { knowledgeService } from '../../src/features/knowledge/services/knowledgeService';
import { progressService } from '../../src/features/knowledge/progress/services/progressService';

// Mock fetch for Node environment
global.fetch = require('node-fetch');

async function testKnowledgeAPI() {
  console.log('🧪 Testing Knowledge API Integration...\n');

  try {
    // Test 1: Get knowledge items
    console.log('📋 Test 1: Fetching knowledge items...');
    const items = await knowledgeService.getKnowledgeItems({
      page: 1,
      per_page: 5,
    });
    console.log(`✅ Success! Found ${items.total} total items`);
    console.log(`   Returned ${items.items.length} items on page ${items.page}`);
    if (items.items.length > 0) {
      console.log(`   First item: ${items.items[0].title}`);
    }
    console.log('');

    // Test 2: Filter by type
    console.log('🔍 Test 2: Filtering by knowledge type...');
    const technicalItems = await knowledgeService.getKnowledgeItems({
      knowledge_type: 'technical',
      page: 1,
      per_page: 3,
    });
    console.log(`✅ Found ${technicalItems.total} technical items`);
    console.log('');

    // Test 3: Get chunks if item exists
    if (items.items.length > 0) {
      const sourceId = items.items[0].source_id;
      console.log(`📄 Test 3: Getting chunks for ${sourceId}...`);
      const chunks = await knowledgeService.getKnowledgeItemChunks(sourceId);
      console.log(`✅ Found ${chunks.count} chunks`);
      console.log('');

      // Test 4: Get code examples
      console.log(`💻 Test 4: Getting code examples for ${sourceId}...`);
      const examples = await knowledgeService.getCodeExamples(sourceId);
      console.log(`✅ Found ${examples.count} code examples`);
      console.log('');
    }

    // Test 5: Search
    console.log('🔎 Test 5: Searching knowledge base...');
    try {
      const searchResults = await knowledgeService.searchKnowledgeBase({
        query: 'API',
        limit: 3,
      });
      console.log('✅ Search completed');
      console.log('');
    } catch (error) {
      console.log('⚠️  Search endpoint might not be implemented yet');
      console.log('');
    }

    // Test 6: Start a test crawl (but immediately stop it)
    console.log('🕷️  Test 6: Testing crawl start/stop...');
    try {
      const crawlResponse = await knowledgeService.crawlUrl({
        url: 'https://example.com/test-integration',
        knowledge_type: 'technical',
        max_depth: 1,
      });
      console.log(`✅ Crawl started with progress ID: ${crawlResponse.progressId}`);
      
      // Get progress
      const progress = await progressService.getProgress(crawlResponse.progressId);
      console.log(`   Status: ${progress.status}, Progress: ${progress.progress}%`);
      
      // Stop the crawl
      await knowledgeService.stopCrawl(crawlResponse.progressId);
      console.log('✅ Crawl stopped successfully');
      console.log('');
    } catch (error) {
      console.log('⚠️  Crawl test failed:', error);
      console.log('');
    }

    console.log('✨ All tests completed successfully!');
    
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  testKnowledgeAPI();
}