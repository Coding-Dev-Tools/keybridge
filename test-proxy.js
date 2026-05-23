// Simple test script for Command Code Proxy
import { fetch } from 'node-fetch';

async function testProxy() {
  const baseUrl = 'http://localhost:3000';
  
  console.log('🧪 Testing Command Code Proxy...\n');
  
  // Test 1: Health check
  console.log('📡 Testing health endpoint...');
  try {
    const healthResponse = await fetch(`${baseUrl}/health`);
    const healthData = await healthResponse.json();
    console.log('✅ Health check passed:', healthData.status);
  } catch (error) {
    console.error('❌ Health check failed:', error.message);
    process.exit(1);
  }
  
  // Test 2: Models endpoint
  console.log('\n📋 Testing models endpoint...');
  try {
    const modelsResponse = await fetch(`${baseUrl}/v1/models`, {
      headers: {
        'Authorization': 'Bearer test-key'
      }
    });
    const modelsData = await modelsResponse.json();
    console.log('✅ Models endpoint working');
    console.log(`   Found ${modelsData.data.length} models`);
    console.log('   Sample model:', modelsData.data[0]?.id || 'None');
  } catch (error) {
    console.error('❌ Models endpoint failed:', error.message);
    process.exit(1);
  }
  
  // Test 3: Chat completion (this might fail if API key is invalid, but we'll test the proxy)
  console.log('\n💬 Testing chat completion endpoint...');
  try {
    const chatResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-key'
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v4-pro',
        messages: [{ role: 'user', content: 'Hello!' }],
        max_tokens: 10,
        temperature: 0.7
      })
    });
    
    const chatData = await chatResponse.json();
    
    if (chatResponse.ok) {
      console.log('✅ Chat completion successful');
      console.log('   Response:', chatData.choices?.[0]?.message?.content || 'No content');
    } else {
      console.log('⚠️  Chat completion returned error (may be expected if API key is invalid)');
      console.log('   Error:', chatData.error?.message || 'Unknown error');
    }
  } catch (error) {
    console.error('❌ Chat completion failed:', error.message);
    process.exit(1);
  }
  
  console.log('\n✅ All proxy tests completed!');
}

testProxy().catch(error => {
  console.error('Test failed:', error);
  process.exit(1);
});