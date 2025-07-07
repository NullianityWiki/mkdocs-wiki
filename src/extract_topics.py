#!/usr/bin/env python3

import os
import csv
import asyncio
from datetime import datetime
from dotenv import load_dotenv
from telethon import TelegramClient
from telethon.tl.types import MessageService, MessageActionTopicCreate
from telethon.tl.functions.channels import GetForumTopicsRequest
from collections import defaultdict

# Load environment variables
load_dotenv('../.env')

API_ID = int(os.getenv('API_ID'))
API_HASH = os.getenv('API_HASH')  
CHAT_ID = int(os.getenv('CHAT_ID'))
BATCH_SIZE = int(os.getenv('BATCH_SIZE', '1000').split('#')[0].strip())
PARALLEL_TOPICS = int(os.getenv('PARALLEL_TOPICS', '3').split('#')[0].strip())
API_DELAY = float(os.getenv('API_DELAY', '0.1').split('#')[0].strip())

# Session file
SESSION_FILE = "user_client_session"

class TopicExtractor:
    def __init__(self):
        self.client = TelegramClient(SESSION_FILE, API_ID, API_HASH)
        
    async def start(self):
        """Initialize client connection"""
        await self.client.start()
        print("Клиент подключен")
        
    async def get_chat_entity(self, chat_id: int):
        """Get chat entity by ID"""
        try:
            entity = await self.client.get_entity(chat_id)
            return entity
        except Exception as e:
            print(f"Ошибка получения чата: {e}")
            return None
    
    async def extract_topics(self, chat_id: int):
        try:
            chat_entity = await self.get_chat_entity(chat_id)
            if not chat_entity:
                return {'success': False, 'error': 'Не удалось получить чат'}
            
            print(f"Чат: {getattr(chat_entity, 'title', 'Unknown')} (ID: {chat_entity.id})")
            
            if not hasattr(chat_entity, 'forum') or not chat_entity.forum:
                return {'success': False, 'error': 'Чат не поддерживает форум'}
            
            print("Форум подтвержден")
            
            forum_topics = await self.get_topics_via_api(chat_entity)
            service_topics = await self.find_service_messages_batch(chat_entity)
            
            if forum_topics or service_topics:
                print("Найдены топики, анализ...")
                detailed_topics = await self.analyze_topics_parallel(chat_entity, forum_topics, service_topics)
                topics_count = len(detailed_topics)
            else:
                print("Топики не найдены через API, полный анализ...")
                detailed_topics = await self.batch_message_analysis(chat_entity)
                topics_count = len(detailed_topics)
            
            return {
                'success': True,
                'count': topics_count,
                'source': 'parallel_extraction'
            }
            
        except Exception as e:
            print(f"Ошибка извлечения: {e}")
            return {'success': False, 'error': str(e)}
    
    async def get_topics_via_api(self, chat_entity):
        """Get topics using GetForumTopics API method"""
        forum_topics = {}
        try:
            print("Получение топиков через API...")
            result = await self.client(GetForumTopicsRequest(
                channel=chat_entity,
                offset_date=None,
                offset_id=0,
                offset_topic=0,
                limit=100
            ))
            
            for topic in result.topics:
                topic_id = topic.id
                forum_topics[topic_id] = {
                    'id': topic_id,
                    'title': topic.title,
                    'created_date': topic.date,
                    'author_id': topic.from_id.user_id if hasattr(topic.from_id, 'user_id') else None,
                    'closed': getattr(topic, 'closed', False)
                }
                print(f"   API топик: {topic_id} '{topic.title}'")
            
            print(f"Получено через API: {len(forum_topics)} топиков")
            
        except Exception as e:
            print(f"API недоступен: {e}")
            
        return forum_topics
    
    async def find_service_messages_batch(self, chat_entity):
        """Find topic creation service messages using batch processing"""
        service_topics = {}
        processed = 0
        offset_id = 0
        
        print("Поиск service messages...")
        
        try:
            while True:
                # Load message batch
                messages = await self.client.get_messages(
                    chat_entity, 
                    limit=BATCH_SIZE,
                    offset_id=offset_id
                )
                
                if not messages:
                    break
                
                # Process batch
                for message in messages:
                    processed += 1
                    
                    if isinstance(message, MessageService) and hasattr(message.action, '__class__'):
                        if message.action.__class__.__name__ == 'MessageActionTopicCreate':
                            topic_id = message.reply_to.reply_to_top_id if message.reply_to else message.id
                            topic_title = getattr(message.action, 'title', f'Топик {topic_id}')
                            
                            service_topics[topic_id] = {
                                'id': topic_id,
                                'title': topic_title,
                                'created_date': message.date,
                                'author_id': message.sender_id,
                                'service_message': message
                            }
                            print(f"   Service топик: {topic_id} '{topic_title}'")
                
                offset_id = messages[-1].id
                print(f"   Обработано: {processed}")
                
                # Rate limiting
                await asyncio.sleep(API_DELAY)
            
            print(f"Найдено service messages: {len(service_topics)}")
            
        except Exception as e:
            print(f"Ошибка поиска service messages: {e}")
        
        return service_topics
    
    async def analyze_topics_parallel(self, chat_entity, forum_topics, service_topics):
        print("Анализ топиков...")
        
        all_topic_ids = list(set(forum_topics.keys()) | set(service_topics.keys()))
        detailed_topics = {}
        
        # Создаем CSV файл и записываем заголовки
        os.makedirs('./exports', exist_ok=True)
        csv_filepath = './exports/forum_topics.csv'
        
        with open(csv_filepath, 'w', newline='', encoding='utf-8') as csvfile:
            fieldnames = ['topic_id', 'topic_name', 'creator_id', 'creator_name', 'count_msgs', 'topic_created', 'topic_last_msg']
            writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
            writer.writeheader()
            csvfile.flush()
        
        semaphore = asyncio.Semaphore(PARALLEL_TOPICS)
        
        async def analyze_single_topic(topic_id):
            async with semaphore:
                try:
                    if topic_id in forum_topics:
                        base_info = forum_topics[topic_id]
                    else:
                        base_info = service_topics[topic_id]
                    
                    print(f"Анализ топика {topic_id}")
                    
                    topic_stats = await self.analyze_topic_messages_batch(chat_entity, topic_id)
                    
                    # Получаем информацию об авторе сразу
                    author_username = 'Unknown'
                    if base_info['author_id']:
                        try:
                            sender = await self.client.get_entity(base_info['author_id'])
                            if hasattr(sender, 'username') and sender.username:
                                author_username = f"@{sender.username}"
                            elif hasattr(sender, 'first_name'):
                                name_parts = []
                                if sender.first_name:
                                    name_parts.append(sender.first_name)
                                if hasattr(sender, 'last_name') and sender.last_name:
                                    name_parts.append(sender.last_name)
                                author_username = ' '.join(name_parts)
                        except Exception as e:
                            print(f"Не удалось получить автора {base_info['author_id']}: {e}")
                    
                    topic_data = {
                        'topic_id': topic_id,
                        'topic_name': base_info['title'],
                        'creator_id': base_info['author_id'] or '',
                        'creator_name': author_username,
                        'count_msgs': topic_stats['count'],
                        'topic_created': base_info['created_date'].strftime('%Y-%m-%d %H:%M:%S'),
                        'topic_last_msg': (topic_stats['last_date'] or base_info['created_date']).strftime('%Y-%m-%d %H:%M:%S')
                    }
                    
                    # Записываем данные сразу в файл
                    with open(csv_filepath, 'a', newline='', encoding='utf-8') as csvfile:
                        writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
                        writer.writerow(topic_data)
                        csvfile.flush()
                    
                    print(f"   Топик {topic_id}: {topic_stats['count']} сообщений - записан в файл")
                    
                    return {
                        'topic_id': topic_id,
                        'title': base_info['title'],
                        'created_date': base_info['created_date'],
                        'author_id': base_info['author_id'],
                        'message_count': topic_stats['count'],
                        'last_message_date': topic_stats['last_date'] or base_info['created_date'],
                    }
                    
                except Exception as e:
                    print(f"   Ошибка анализа топика {topic_id}: {e}")
                    return None
        
        print(f"Обработка {len(all_topic_ids)} топиков...")
        tasks = [analyze_single_topic(topic_id) for topic_id in all_topic_ids]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        
        for result in results:
            if result and not isinstance(result, Exception):
                detailed_topics[result['topic_id']] = result
        
        # Подсчитываем общее количество сообщений
        total_messages = sum(topic['message_count'] for topic in detailed_topics.values())
        print(f"\nСтатистика:")
        print(f"   Всего топиков: {len(detailed_topics)}")
        print(f"   Всего сообщений: {total_messages}")
        print(f"Данные сохранены: {csv_filepath}")
        
        return detailed_topics
    
    async def analyze_topic_messages_batch(self, chat_entity, topic_id):
        """Analyze messages in specific topic using batch processing"""
        stats = {'count': 0, 'last_date': None}
        offset_id = 0
        
        try:
            # Try reply_to method first (faster)
            async for message in self.client.iter_messages(chat_entity, reply_to=topic_id):
                if not isinstance(message, MessageService):
                    stats['count'] += 1
                    if not stats['last_date'] or message.date > stats['last_date']:
                        stats['last_date'] = message.date
            
            # Fallback to alternative method with batches
            if stats['count'] == 0:
                batch_count = 0
                while True:
                    messages = await self.client.get_messages(
                        chat_entity, 
                        limit=BATCH_SIZE,
                        offset_id=offset_id
                    )
                    
                    if not messages:
                        break
                    
                    for message in messages:
                        batch_count += 1
                        if (message.reply_to and 
                            message.reply_to.reply_to_top_id == topic_id and 
                            not isinstance(message, MessageService)):
                            stats['count'] += 1
                            if not stats['last_date'] or message.date > stats['last_date']:
                                stats['last_date'] = message.date
                    
                    offset_id = messages[-1].id
                    
                    # Rate limiting
                    await asyncio.sleep(API_DELAY)
                    
                    if batch_count % (BATCH_SIZE * 10) == 0:
                        print(f"     Топик {topic_id}: просмотрено {batch_count}")
            
        except Exception as e:
            print(f"     Ошибка анализа топика {topic_id}: {e}")
        
        return stats
    
    async def batch_message_analysis(self, chat_entity):
        print("Полный анализ сообщений...")
        
        # Создаем CSV файл и записываем заголовки
        os.makedirs('./exports', exist_ok=True)
        csv_filepath = './exports/forum_topics.csv'
        
        with open(csv_filepath, 'w', newline='', encoding='utf-8') as csvfile:
            fieldnames = ['topic_id', 'topic_name', 'creator_id', 'creator_name', 'count_msgs', 'topic_created', 'topic_last_msg']
            writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
            writer.writeheader()
            csvfile.flush()
        
        topics_stats = defaultdict(lambda: {'count': 0, 'first_date': None, 'last_date': None, 'first_author': None})
        processed_count = 0
        offset_id = 0
        
        try:
            while True:
                messages = await self.client.get_messages(
                    chat_entity, 
                    limit=BATCH_SIZE,
                    offset_id=offset_id
                )
                
                if not messages:
                    break
                
                for message in messages:
                    processed_count += 1
                    
                    topic_id = None
                    if message.reply_to and message.reply_to.reply_to_top_id:
                        topic_id = message.reply_to.reply_to_top_id
                    
                    if topic_id and not isinstance(message, MessageService):
                        stats = topics_stats[topic_id]
                        stats['count'] += 1
                        
                        if not stats['first_date'] or message.date < stats['first_date']:
                            stats['first_date'] = message.date
                            stats['first_author'] = message.sender_id
                            
                        if not stats['last_date'] or message.date > stats['last_date']:
                            stats['last_date'] = message.date
                
                offset_id = messages[-1].id
                
                if processed_count % BATCH_SIZE == 0:
                    print(f"   Обработано: {processed_count}, найдено топиков: {len(topics_stats)}")
                
                await asyncio.sleep(API_DELAY)
            
            print(f"Анализ завершен: {len(topics_stats)} топиков")
            
        except Exception as e:
            print(f"Ошибка анализа: {e}")
        
        # Сохраняем каждый топик в файл
        detailed_topics = {}
        for topic_id, stats in topics_stats.items():
            if stats['count'] > 0:
                # Получаем информацию об авторе
                author_username = 'Unknown'
                if stats['first_author']:
                    try:
                        sender = await self.client.get_entity(stats['first_author'])
                        if hasattr(sender, 'username') and sender.username:
                            author_username = f"@{sender.username}"
                        elif hasattr(sender, 'first_name'):
                            name_parts = []
                            if sender.first_name:
                                name_parts.append(sender.first_name)
                            if hasattr(sender, 'last_name') and sender.last_name:
                                name_parts.append(sender.last_name)
                            author_username = ' '.join(name_parts)
                    except Exception as e:
                        print(f"Не удалось получить автора {stats['first_author']}: {e}")
                
                topic_data = {
                    'topic_id': topic_id,
                    'topic_name': f'Топик {topic_id}',
                    'creator_id': stats['first_author'] or '',
                    'creator_name': author_username,
                    'count_msgs': stats['count'],
                    'topic_created': stats['first_date'].strftime('%Y-%m-%d %H:%M:%S'),
                    'topic_last_msg': stats['last_date'].strftime('%Y-%m-%d %H:%M:%S')
                }
                
                # Записываем данные сразу в файл
                with open(csv_filepath, 'a', newline='', encoding='utf-8') as csvfile:
                    writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
                    writer.writerow(topic_data)
                    csvfile.flush()
                
                print(f"   Топик {topic_id}: {stats['count']} сообщений - записан в файл")
                
                detailed_topics[topic_id] = {
                    'topic_id': topic_id,
                    'title': f'Топик {topic_id}',
                    'created_date': stats['first_date'],
                    'author_id': stats['first_author'],
                    'message_count': stats['count'],
                    'last_message_date': stats['last_date'],
                }
        
        # Подсчитываем общее количество сообщений
        total_messages = sum(topic['message_count'] for topic in detailed_topics.values())
        print(f"\nСтатистика:")
        print(f"   Всего топиков: {len(detailed_topics)}")
        print(f"   Всего сообщений: {total_messages}")
        print(f"Данные сохранены: {csv_filepath}")
        
        return detailed_topics

async def main():
    print("Извлечение топиков форума")
    print(f"Чат: {CHAT_ID}")
    
    extractor = TopicExtractor()
    
    try:
        await extractor.start()
        
        result = await extractor.extract_topics(CHAT_ID)
        
        if result['success']:
            print("\nЭкспорт завершен успешно")
        else:
            print(f"\nОшибка извлечения: {result['error']}")
            
    except Exception as e:
        print(f"Критическая ошибка: {e}")
    finally:
        await extractor.client.disconnect()
        print("\nКлиент отключен")

if __name__ == '__main__':
    asyncio.run(main()) 
