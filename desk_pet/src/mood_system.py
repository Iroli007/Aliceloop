"""
心情系统
管理桌宠的情绪状态和对话内容
"""
import random
from enum import Enum
from PyQt6.QtCore import QObject, pyqtSignal


class Mood(Enum):
    """心情枚举"""
    HAPPY = "happy"
    NORMAL = "idle"
    SAD = "sad"
    SLEEPY = "sleepy"


class MoodSystem(QObject):
    """心情系统"""
    
    mood_changed = pyqtSignal(str)
    
    def __init__(self):
        super().__init__()
        
        # 心情值 (0-100)
        self.mood_value = 50
        self.current_mood = Mood.NORMAL.value
        
        # 上次互动时间
        self.last_interaction = 0
        
        # 对话库
        self._init_dialogues()
        
    def _init_dialogues(self):
        """初始化对话库"""
        self.dialogues = {
            'random': {
                Mood.HAPPY.value: [
                    "今天心情真好～",
                    "主人主人，陪我玩嘛！",
                    "嘿嘿，好开心！",
                    "世界真美好！",
                    "我是最幸福的桌宠！"
                ],
                Mood.NORMAL.value: [
                    "有点无聊呢...",
                    "主人你在忙什么呀？",
                    "我在这儿哦～",
                    "要不要休息一下？",
                    "今天天气怎么样？"
                ],
                Mood.SAD.value: [
                    "呜呜...",
                    "感觉好孤单...",
                    "主人不理我了...",
                    "心情有点低落...",
                    "需要抱抱..."
                ],
                Mood.SLEEPY.value: [
                    "好困啊...",
                    "zzZZ...",
                    "想睡觉觉了...",
                    "眼睛睁不开了...",
                    "晚安..."
                ]
            },
            'click': {
                Mood.HAPPY.value: [
                    "哎呀，好痒！",
                    "主人最喜欢我了！",
                    "再来一下嘛～"
                ],
                Mood.NORMAL.value: [
                    "被戳到了！",
                    "有什么事吗？",
                    "哎呀！"
                ],
                Mood.SAD.value: [
                    "别戳我了...",
                    "疼...",
                    "呜呜..."
                ],
                Mood.SLEEPY.value: [
                    "让我睡觉...",
                    "困...",
                    "zzZ..."
                ]
            },
            'pet': {
                Mood.HAPPY.value: [
                    "好舒服～",
                    "最喜欢被摸摸了！",
                    "主人的手好温暖～"
                ],
                Mood.NORMAL.value: [
                    "嗯？",
                    "被抓住了？",
                    "要带我去哪？"
                ],
                Mood.SAD.value: [
                    "终于理我了...",
                    "不要放开我...",
                    "多陪陪我..."
                ],
                Mood.SLEEPY.value: [
                    "抱着我睡...",
                    "好困...",
                    "晚安..."
                ]
            },
            'release': {
                Mood.HAPPY.value: [
                    "谢谢主人！",
                    "好开心！",
                    "再来玩呀～"
                ],
                Mood.NORMAL.value: [
                    "放开了呢...",
                    "我在这儿哦",
                    "随时找我玩～"
                ],
                Mood.SAD.value: [
                    "不要走...",
                    "又一个人了...",
                    "早点回来..."
                ],
                Mood.SLEEPY.value: [
                    "去睡觉了...",
                    "zzZ...",
                    "晚安..."
                ]
            }
        }
        
    def interact(self, interaction_type: str):
        """
        处理互动
        
        Args:
            interaction_type: 互动类型 ('click', 'pet', 'feed' 等)
        """
        if interaction_type == 'click':
            self._change_mood(5)
        elif interaction_type == 'pet':
            self._change_mood(10)
        elif interaction_type == 'feed':
            self._change_mood(15)
            
    def _change_mood(self, delta: int):
        """
        改变心情值
        
        Args:
            delta: 变化量（正数增加，负数减少）
        """
        old_mood = self.current_mood
        self.mood_value = max(0, min(100, self.mood_value + delta))
        
        # 根据心情值确定状态
        if self.mood_value >= 70:
            self.current_mood = Mood.HAPPY.value
        elif self.mood_value >= 40:
            self.current_mood = Mood.NORMAL.value
        elif self.mood_value >= 20:
            self.current_mood = Mood.SAD.value
        else:
            self.current_mood = Mood.SLEEPY.value
            
        # 发送信号
        if self.current_mood != old_mood:
            self.mood_changed.emit(self.current_mood)
            
    def decay_mood(self):
        """心情自然衰减"""
        self._change_mood(-5)
        
    def get_random_dialogue(self) -> str:
        """获取随机对话"""
        dialogues = self.dialogues['random'].get(self.current_mood, [])
        if dialogues:
            return random.choice(dialogues)
        return "..."
        
    def get_dialogue(self, dialogue_type: str) -> str:
        """
        获取特定类型的对话
        
        Args:
            dialogue_type: 对话类型 ('random', 'click', 'pet', 'release')
        """
        type_dialogues = self.dialogues.get(dialogue_type, {})
        dialogues = type_dialogues.get(self.current_mood, ["..."])
        return random.choice(dialogues)
        
    def get_mood_text(self) -> str:
        """获取当前心情的文字描述"""
        mood_texts = {
            Mood.HAPPY.value: "开心",
            Mood.NORMAL.value: "平静",
            Mood.SAD.value: "难过",
            Mood.SLEEPY.value: "困倦"
        }
        return mood_texts.get(self.current_mood, "未知")
